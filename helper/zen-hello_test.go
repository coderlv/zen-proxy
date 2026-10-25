package main

import (
	"encoding/hex"
	"net"
	"testing"
	"time"

	utls "github.com/refraction-networking/utls"
)

// What this program writes on the wire has to be the captured hello field by
// field, key_share content aside — that content is the key it must compute. A raw
// loopback listener reads the first record and never answers, so the handshake
// fails after the hello and nothing leaves the machine.
func TestHelloOnTheWireMatchesTheCapture(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	hello := make(chan []byte, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 4096)
		n, err := c.Read(buf)
		if err == nil && n > 0 {
			hello <- buf[:n]
		}
	}()

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	cfg := &utls.Config{
		ServerName:       "opencode.ai",
		MaxVersion:       utls.VersionTLS13,
		CurvePreferences: []utls.CurveID{utls.X25519MLKEM768, utls.X25519},
	}
	uconn := utls.UClient(conn, cfg, utls.HelloCustom)
	if err := uconn.ApplyPreset(specFor("opencode.ai")); err != nil {
		t.Fatal(err)
	}
	go uconn.Handshake()

	select {
	case b := <-hello:
		checkHello(t, b)
	case <-time.After(5 * time.Second):
		t.Fatal("nothing was written")
	}
}

type keyShareEntry struct {
	group int
	size  int
}

func checkHello(t *testing.T, record []byte) {
	if len(record) < 9 || record[0] != 0x16 || record[5] != 0x01 {
		t.Fatalf("not a client hello record: %x", record[:min(len(record), 16)])
	}
	body := record[9:]
	if body[0] != 0x03 || body[1] != 0x03 {
		t.Errorf("legacy version %x, the capture sends 0303", body[:2])
	}
	off := 2 + 32
	if body[off] != 32 {
		t.Errorf("session id length %d, the capture sends 32", body[off])
	}
	off += 1 + int(body[off])
	n := int(body[off])<<8 | int(body[off+1])
	if n != 2*len(ciphers) {
		t.Fatalf("cipher list is %d bytes, the capture has %d ciphers (%d bytes)", n, len(ciphers), 2*len(ciphers))
	}
	for i := range n / 2 {
		if got := int(body[off+2+i*2])<<8 | int(body[off+3+i*2]); got != int(ciphers[i]) {
			t.Errorf("cipher %d is %04x, the capture has %04x", i, got, ciphers[i])
		}
	}
	off += 2 + n
	if body[off] != 1 || body[off+1] != 0 {
		t.Errorf("compression methods %x, the capture sends one null method", body[off:off+2])
	}
	off += 1 + int(body[off])
	elen := int(body[off])<<8 | int(body[off+1])
	off += 2
	end := off + elen
	// The table holds extension payloads, not the internal length prefix some of
	// them carry on the wire, so the comparison has to look through it.
	prefixLen := map[uint16]int{0x000b: 1, 0x000d: 2, 0x0010: 2, 0x002b: 1}
	for i, want := range extensions {
		if off >= end {
			t.Fatalf("extension %d (0x%04x) is missing", i, want.id)
		}
		id := int(body[off])<<8 | int(body[off+1])
		l := int(body[off+2])<<8 | int(body[off+3])
		data := body[off+4 : off+4+l]
		if id != int(want.id) {
			t.Fatalf("extension %d is 0x%04x, the capture has 0x%04x: order is the fingerprint", i, id, want.id)
		}
		if want.id == 0x0000 {
			// server_name is rebuilt per connection; only that it is present matters.
			off += 4 + l
			continue
		}
		if want.data != "" {
			content := data
			if w, ok := prefixLen[want.id]; ok {
				n := 0
				for j := range w {
					n = n<<8 | int(data[j])
				}
				if n != len(want.data)/2 {
					t.Errorf("extension 0x%04x writes a %d-byte payload, the capture has %d", want.id, n, len(want.data)/2)
				}
				content = data[w:]
			}
			if hex.EncodeToString(content) != want.data {
				t.Errorf("extension 0x%04x content is %x, the capture has %s", want.id, content, want.data)
			}
		}
		if want.id == 0x0033 {
			// key_share content is ours, the shape is the capture's: two entries, the
			// ML-KEM one first at 1216 bytes, then X25519 at 32.
			got := []keyShareEntry{}
			for p := data[2:]; len(p) > 0; {
				g := int(p[0])<<8 | int(p[1])
				s := int(p[2])<<8 | int(p[3])
				got = append(got, keyShareEntry{g, s})
				p = p[4+s:]
			}
			wantEntries := []keyShareEntry{{4588, 1216}, {29, 32}}
			if len(got) != len(wantEntries) {
				t.Fatalf("key_share has %d entries, the capture has %d", len(got), len(wantEntries))
			}
			for j, e := range wantEntries {
				if got[j] != e {
					t.Errorf("key_share entry %d is %v, the capture is %v", j, got[j], e)
				}
			}
		}
		off += 4 + l
	}
	if len(body) != 1493 {
		t.Errorf("hello body is %d bytes, the capture is 1493", len(body))
	}
}
