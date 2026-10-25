package main

// zen-hello is the TLS front end that sends opencode's own ClientHello. Node's
// OpenSSL cannot build that hello: every group in the captured list is GREASE or
// unknown to OpenSSL, so it refuses to assemble the hello at all. uTLS can, so
// the handshake lives here and nothing else does.
//
// zen-proxy connects to it over plain TCP, sends "CONNECT <host>:<port>" with an
// X-Proxy header naming the proxy entry, and then speaks HTTP on the stream it
// gets back. The helper chains to that entry, does the handshake, and pipes.
//
//	go build -o zen-hello . && ./zen-hello            # listens on 127.0.0.1:18901
//	ZEN_HELLO_PORT=18901 ZEN_HELLO_PROXY=<entry> go run .
//
// One part of the hello cannot be replayed: key_share. We have to compute the
// shared secret, so its content and length are ours, not the binary's. Everything
// else — ciphers, extension order, group ids, point formats, signature algorithms,
// ALPN, and every extension payload — is the 2026-10-25 capture byte for byte.
// Extension order here is the wire order, so nothing sorts or rewrites it.

import (
	"bufio"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	utls "github.com/refraction-networking/utls"
)

// Captured ClientHello, from the opencode 2.1.4 binary through one proxy entry.
// Hex is extension payload data; ids are in the order the binary sends them.
var ciphers = mustHexList("1301 1302 1303 c02b c02f c02c c030 cca9 cca8 c009 c013 c00a c014 009c 009d 002f 0035")

type ext struct {
	id   uint16
	data string // extension payload, as hex
}

var extensions = []ext{
	{0x0000, ""}, // server_name: rebuilt per connection
	{0x0017, ""},
	{0xff01, "00"},
	{0x000a, "000811ec001d00170018"},
	{0x000b, "00"},
	{0x0023, ""},
	{0x0010, "08687474702f312e31"},
	{0x0005, "0100000000"},
	{0x000d, "04030804040105030805050108060601080706030201"},
	{0x0012, ""},
	{0x0033, ""}, // key_share: generated, see the note above
	{0x002d, "0101"},
	{0x002b, "03040303"},
}

func mustHexList(s string) []uint16 {
	out := []uint16{}
	for _, x := range strings.Fields(s) {
		v, err := strconv.ParseUint(x, 16, 16)
		if err != nil {
			log.Fatalf("bad hex id %q", x)
		}
		out = append(out, uint16(v))
	}
	return out
}

func pairs(b []byte) []uint16 {
	out := []uint16{}
	for i := range len(b) / 2 {
		out = append(out, uint16(b[i*2])<<8|uint16(b[i*2+1]))
	}
	return out
}

func specFor(host string) *utls.ClientHelloSpec {
	list := []utls.TLSExtension{}
	for _, e := range extensions {
		data, err := hex.DecodeString(e.data)
		if err != nil {
			log.Fatalf("bad extension data: %v", err)
		}
		switch e.id {
		case 0:
			list = append(list, &utls.SNIExtension{ServerName: host})
		case 0x000a:
			// uTLS validates curve ids it cannot compute a key share for, so the
			// captured list goes out as data and the preferences below drive the key.
			list = append(list, &utls.GenericExtension{Id: e.id, Data: data})
		case 0x000b:
			list = append(list, &utls.SupportedPointsExtension{SupportedPoints: data})
		case 0x000d:
			sigs := []utls.SignatureScheme{}
			for _, v := range pairs(data) {
				sigs = append(sigs, utls.SignatureScheme(v))
			}
			list = append(list, &utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: sigs})
		case 0x0023:
			// uTLS's typed version writes nothing, so this stays raw.
			list = append(list, &utls.GenericExtension{Id: e.id, Data: data})
		case 0x0010:
			protos := []string{}
			p := data
			for len(p) > 0 {
				l := int(p[0])
				protos = append(protos, string(p[1:1+l]))
				p = p[1+l:]
			}
			list = append(list, &utls.ALPNExtension{AlpnProtocols: protos})
		case 0x002b:
			list = append(list, &utls.SupportedVersionsExtension{Versions: pairs(data)})
		case 0x0033:
			list = append(list, &utls.KeyShareExtension{KeyShares: []utls.KeyShare{{Group: utls.X25519MLKEM768}, {Group: utls.X25519}}})
		default:
			list = append(list, &utls.GenericExtension{Id: e.id, Data: data})
		}
	}
	return &utls.ClientHelloSpec{CipherSuites: ciphers, CompressionMethods: []uint8{0}, Extensions: list}
}

// entryFrom reads the proxy entry zen-proxy named for this connection, falling
// back to the one the helper was started with.
func entryFrom(r *http.Request) (*url.Userinfo, string, error) {
	raw := r.Header.Get("X-Proxy")
	if raw == "" {
		raw = os.Getenv("ZEN_HELLO_PROXY")
	}
	if raw == "" {
		return nil, "", nil
	}
	if !strings.HasPrefix(raw, "http://") {
		raw = strings.Replace(raw, "http:", "http://", 1)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, "", err
	}
	return u.User, u.Host, nil
}

func main() {
	port := os.Getenv("ZEN_HELLO_PORT")
	if port == "" {
		port = "18901"
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("zen-hello on 127.0.0.1:%s", port)
	for {
		conn, err := ln.Accept()
		if err != nil {
			continue
		}
		go serve(conn)
	}
}

func serve(client net.Conn) {
	defer client.Close()

	req, err := http.ReadRequest(bufio.NewReader(client))
	if err != nil {
		return
	}
	if req.Method != "CONNECT" {
		client.Write([]byte("HTTP/1.1 405 Method Not Allowed\r\n\r\n"))
		return
	}
	host, portstr, err := net.SplitHostPort(req.URL.Host)
	if err != nil {
		client.Write([]byte("HTTP/1.1 400 Bad Request\r\n\r\n"))
		return
	}
	port := portstr
	if port == "" {
		port = "443"
	}

	user, proxyHost, err := entryFrom(req)
	if err != nil {
		client.Write([]byte("HTTP/1.1 400 Bad Request\r\n\r\n"))
		return
	}
	up, err := net.Dial("tcp", proxyHost)
	if proxyHost == "" {
		up, err = net.Dial("tcp", net.JoinHostPort(host, port))
	}
	if err != nil {
		client.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
		return
	}
	// A proxy needs a CONNECT first; a direct dial already is the stream.
	if proxyHost != "" {
		if user != nil {
			fmt.Fprintf(up, "CONNECT %s:%s HTTP/1.1\r\nHost: %s:%s\r\nProxy-Authorization: Basic %s\r\n\r\n", host, port, host, port, basic(user))
		} else {
			fmt.Fprintf(up, "CONNECT %s:%s HTTP/1.1\r\nHost: %s:%s\r\n\r\n", host, port, host, port)
		}
		line, err := bufio.NewReader(up).ReadString('\n')
		if err != nil || !strings.Contains(line, "200") {
			log.Printf("%s: proxy said %s", host, strings.TrimSpace(line))
			up.Close()
			client.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
			return
		}
	}

	cfg := &utls.Config{
		ServerName:       host,
		MaxVersion:       utls.VersionTLS13,
		CurvePreferences: []utls.CurveID{utls.X25519MLKEM768, utls.X25519},
	}
	tlsConn := utls.UClient(up, cfg, utls.HelloCustom)
	if err := tlsConn.ApplyPreset(specFor(host)); err != nil {
		log.Printf("%s: preset: %v", host, err)
		up.Close()
		client.Write([]byte("HTTP/1.1 500 Internal Server Error\r\n\r\n"))
		return
	}
	if err := tlsConn.Handshake(); err != nil {
		log.Printf("%s: handshake: %v", host, err)
		up.Close()
		client.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
		return
	}

	client.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
	log.Printf("%s via %s", net.JoinHostPort(host, port), masked(user, proxyHost))
	done := make(chan struct{})
	go func() {
		io.Copy(tlsConn, client)
		close(done)
	}()
	io.Copy(client, tlsConn)
	<-done
}

func basic(user *url.Userinfo) string {
	name, pass := user.Username(), ""
	if p, ok := user.Password(); ok {
		pass = p
	}
	return base64.StdEncoding.EncodeToString([]byte(name + ":" + pass))
}

// Entry as it should appear in the log: credentials never printed in full.
func masked(user *url.Userinfo, host string) string {
	if user == nil {
		return host
	}
	name, pass := user.Username(), ""
	if p, ok := user.Password(); ok {
		pass = p
	}
	if pass == "" {
		return fmt.Sprintf("%s@%s", name, host)
	}
	return fmt.Sprintf("%s:••••@%s", name, host)
}
