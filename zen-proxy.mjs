#!/usr/bin/env node
import http from "node:http"
import net from "node:net"
import tls from "node:tls"
import fs from "node:fs"
import path from "node:path"
import { randomBytes, createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
const CONFIG_PATH = process.env.ZEN_PROXY_CONFIG || path.join(__dirname, "zen-proxy.json")
const UI_PATH = path.join(__dirname, "public", "index.html")
const ENV = process.env

// Model ids only ever travel inside JSON bodies, never a URL or a path, so the
// guarantee here is narrow but real: whitespace, quotes, backslashes and shell
// metacharacters can never enter a catalog or config value. `/` and `.` stay
// because provider-qualified ids legitimately use them (`nvidia/nemotron-3-free`).
const VALID_MODEL_ID = /^[A-Za-z0-9._:@+/%-]+$/

// Upstream base URL. `/inference/v1` is the base OpenCode documents and the one
// the CLI itself uses; the older `/zen/v1` path still answers /models but now
// rejects genuine agent traffic with `403 FreeTierError`, so a config that
// still points at it silently loses every free model.
const DEFAULT_UPSTREAM = "https://opencode.ai/inference/v1"
const LEGACY_UPSTREAMS = new Set(["https://opencode.ai/zen/v1", "https://opencode.ai/zen"])
function normalizeUpstream(v) {
  const u = String(v ?? "").trim().replace(/\/+$/, "")
  if (!u) return DEFAULT_UPSTREAM
  return LEGACY_UPSTREAMS.has(u.toLowerCase()) ? DEFAULT_UPSTREAM : u
}

// ---- shipped model catalog -------------------------------------------------
// models.json is the source of truth for which free models we offer. The
// model-sync GitHub Action keeps it current from opencode's public /models
// endpoint — new free models get appended, ones upstream drops get removed — so
// a fresh install always starts on the current list without touching this file.
// Baked in as a last resort so the proxy still runs if models.json is missing
// (an older checkout, or a partial install).
const MODELS_PATH = process.env.ZEN_PROXY_MODELS || path.join(__dirname, "models.json")
const BAKED_MODELS = [
  "space-bunny-free",
  "mimo-v2.6-flash-free",
  "big-pickle",
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "nemotron-3.5-lightning-free",
  "longcat-2.5-preview-free",
  "step-5-preview-free",
  "cat-jam-free",
  "deepseek-v4.1-flash-free",
  "nemotron-3.5-super-vl-free",
]
function loadShippedModels() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODELS_PATH, "utf8"))
    const models = Array.isArray(parsed?.models) ? parsed.models : []
    const clean = models.filter((id) => typeof id === "string" && VALID_MODEL_ID.test(id))
    if (clean.length) return clean
  } catch {}
  return [...BAKED_MODELS]
}

// ---- opencode agent preamble ------------------------------------------------
// The free tier refuses traffic that doesn't carry opencode's own agent framing,
// so an Anthropic client (Claude Code) whose system prompt is Anthropic's gets
// `403 FreeTierError` no matter how correctly it is translated. We put this
// captured opencode preamble *in front of* the client's instructions and leave
// everything the client sent intact and in order — the client's prompt is larger
// and comes later, so it still governs behaviour, but the request is now shaped
// like agent traffic and is accepted.
//
// The exact text matters: the gate is not satisfied by neutral or generic agent
// boilerplate (tested), only by opencode's real framing, and it degrades if the
// preamble is truncated much below this length. It is prepended, never
// substituted, so the client's own system prompt is always preserved.
const AGENT_PREAMBLE_TEXT = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ≤50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- If a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools`

// ---- opencode agent tools ---------------------------------------------------
// Measured behaviour of the free tier's gate: a request is accepted when it
// carries a valid session pair, `stream: true`, and opencode's *own* tool
// manifest alongside the caller's tools. The caller's system prompt is fine as
// it stands — it does not have to be opencode's — so Claude Code's instructions
// are passed through untouched.
//
// The model still prefers opencode's tool names (it can see both), so on the way
// back we rename them to the caller's equivalents and rename their arguments. We
// only offer an opencode tool when the caller actually has the counterpart, so
// the model can never pick a tool the caller is unable to run.
const AGENT_TOOLS_PATH = process.env.ZEN_PROXY_AGENT_TOOLS || path.join(__dirname, "agent-tools.json")
const AGENT_TOOL_MAP = {
  read: { name: "Read", args: { filePath: "file_path" } },
  edit: { name: "Edit", args: { filePath: "file_path", oldString: "old_string", newString: "new_string", replaceAll: "replace_all" } },
  write: { name: "Write", args: { filePath: "file_path" } },
  // null means "this argument has no counterpart on the caller's tool; drop it".
  bash: { name: "Bash", args: { workdir: null } },
  grep: { name: "Grep", args: {} },
  glob: { name: "Glob", args: {} },
  list: { name: "LS", args: {} },
}
let agentToolsCache = null
function loadAgentTools() {
  if (agentToolsCache) return agentToolsCache
  agentToolsCache = []
  try {
    const parsed = JSON.parse(fs.readFileSync(AGENT_TOOLS_PATH, "utf8"))
    const tools = Array.isArray(parsed?.tools) ? parsed.tools : []
    // chatToolsToResponses() drops tools without type, which would make the
    // bridge tool unconvertible and kill the process mid-request.
    agentToolsCache = tools.filter((t) => t?.type === "function" && t?.function?.name && AGENT_TOOL_MAP[t.function.name])
  } catch {}
  return agentToolsCache
}

// The gate wants opencode's tools, but a caller that sends none — a plain chat,
// pi's auto-compaction — has nothing for agentToolsFor() to match. opencode
// attaches its whole registry on every call and never filters it by relevance,
// so the proxy sends the whole manifest too; the gate takes it on `read` alone.
function gateBridgeTools() {
  return config.agentTools ? loadAgentTools() : []
}

// The subset of opencode tools whose mapped name the caller actually offers.
function agentToolsFor(callerToolNames) {
  if (!config.agentTools) return []
  const wanted = callerToolNames instanceof Set ? callerToolNames : new Set(callerToolNames ?? [])
  return loadAgentTools().filter((t) => wanted.has(AGENT_TOOL_MAP[t.function.name].name))
}

// An opencode tool call rewritten as the caller's tool call.
function remapAgentTool(name, rawArgs) {
  const spec = AGENT_TOOL_MAP[name]
  if (!spec) return null
  let args = {}
  try {
    args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs ?? {}
  } catch {
    args = {}
  }
  const out = {}
  for (const [k, v] of Object.entries(args)) {
    if (k in spec.args) {
      if (spec.args[k] === null) continue
      out[spec.args[k]] = v
    } else {
      out[k] = v
    }
  }
  return { name: spec.name, args: JSON.stringify(out) }
}

// ---- outbound proxies -------------------------------------------------------
// Upstream traffic can leave through a pool of HTTP(S) or SOCKS5 proxies. The
// tunnels are hand-rolled on net/tls so the project stays dependency-free, and
// the result is wrapped in a standard Response so every caller (streams
// included) is unchanged.
const PROXY_SCHEMES = new Set(["http:", "https:", "socks5:", "socks5h:"])
const PROXY_STRATEGIES = ["round-robin", "random", "sticky", "least-used", "failover"]
// shortcut: fixed cap on TCP connect + proxy handshake, make it a config key if slow proxies need more
const PROXY_CONNECT_TIMEOUT_MS = 10_000

// Accepts `scheme://user:pass@host:port`, `user:pass@host:port`, `host:port`
// and the `host:port:user:pass` export most proxy sellers use. Returns a
// normalised URL string, null for blank/comment lines, and throws on garbage.
function parseProxyLine(line, scheme = "http") {
  let s = String(line ?? "").trim()
  if (!s || s.startsWith("#")) return null
  if (!/^[a-z0-9]+:\/\//i.test(s)) {
    const parts = s.split(":")
    if (parts.length === 4 && /^\d+$/.test(parts[1])) {
      s = `${encodeURIComponent(parts[2])}:${encodeURIComponent(parts[3])}@${parts[0]}:${parts[1]}`
    }
    s = `${scheme}://${s}`
  }
  let u
  try {
    u = new URL(s)
  } catch {
    throw new Error(`not a proxy: ${line}`)
  }
  if (!PROXY_SCHEMES.has(u.protocol)) throw new Error(`unsupported proxy scheme ${u.protocol} (use http, https or socks5)`)
  if (!u.hostname) throw new Error(`proxy needs a host: ${line}`)
  // Keep the port explicit even when it is the scheme default, so the list reads back as typed.
  const port = u.port || (u.protocol.startsWith("socks") ? 1080 : u.protocol === "https:" ? 443 : 80)
  return `${u.protocol}//${u.username ? `${u.username}:${u.password}@` : ""}${u.hostname}:${port}`
}

// A batch is newline- or comma-separated text, or an array of lines.
function parseProxyList(input, scheme = "http") {
  const lines = Array.isArray(input) ? input : String(input ?? "").split(/[\r\n,]+/)
  const proxies = []
  const errors = []
  for (const line of lines) {
    try {
      const p = parseProxyLine(line, scheme)
      if (p && !proxies.includes(p)) proxies.push(p)
    } catch (err) {
      errors.push(err.message)
    }
  }
  return { proxies, errors }
}

function proxyId(url) {
  return createHash("sha1").update(url).digest("hex").slice(0, 10)
}

function maskProxy(url) {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.username ? `${decodeURIComponent(u.username)}:••••@` : ""}${u.host}`
  } catch {
    return "(invalid)"
  }
}

// Reads a handshake off a raw socket: exact byte counts for SOCKS, a
// terminator for the HTTP CONNECT reply.
function socketReader(sock) {
  let buf = Buffer.alloc(0)
  let wake = null
  const onData = (d) => {
    buf = Buffer.concat([buf, d])
    wake?.()
  }
  sock.on("data", onData)
  const until = async (ready) => {
    while (!ready()) await new Promise((r) => (wake = r))
    wake = null
  }
  return {
    async read(n) {
      await until(() => buf.length >= n)
      const out = buf.subarray(0, n)
      buf = buf.subarray(n)
      return out
    },
    async readUntil(sep) {
      await until(() => buf.includes(sep))
      const end = buf.indexOf(sep) + sep.length
      const out = buf.subarray(0, end)
      buf = buf.subarray(end)
      return out
    },
    done() {
      sock.off("data", onData)
      sock.pause()
      if (buf.length) sock.unshift(buf)
    },
  }
}

async function httpConnectHandshake(sock, p, host, port) {
  const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`
  let head = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`
  if (p.username) {
    const cred = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`
    head += `Proxy-Authorization: Basic ${Buffer.from(cred).toString("base64")}\r\n`
  }
  sock.write(head + "\r\n")
  const r = socketReader(sock)
  const reply = (await r.readUntil("\r\n\r\n")).toString("latin1")
  r.done()
  const status = Number(reply.split(" ")[1])
  if (status !== 200) throw new Error(status === 407 ? "proxy rejected the credentials (407)" : `proxy CONNECT failed: ${reply.split("\r\n")[0]}`)
}

const SOCKS_ERRORS = ["", "general failure", "not allowed by ruleset", "network unreachable", "host unreachable", "connection refused", "TTL expired", "command not supported", "address type not supported"]
async function socks5Handshake(sock, p, host, port) {
  const r = socketReader(sock)
  const auth = !!p.username
  sock.write(Buffer.from(auth ? [5, 2, 0x00, 0x02] : [5, 1, 0x00]))
  const [ver, method] = await r.read(2)
  if (ver !== 5) throw new Error("not a SOCKS5 proxy")
  if (method === 0x02) {
    // RFC 1929 username/password sub-negotiation.
    const user = Buffer.from(decodeURIComponent(p.username))
    const pass = Buffer.from(decodeURIComponent(p.password))
    sock.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
    const [, ok] = await r.read(2)
    if (ok !== 0) throw new Error("SOCKS5 proxy rejected the credentials")
  } else if (method !== 0x00) {
    throw new Error(auth ? "SOCKS5 proxy offers no supported auth method" : "SOCKS5 proxy requires credentials")
  }
  // Always send the hostname (ATYP 3) so DNS resolves at the proxy, not here.
  const name = Buffer.from(host)
  sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 0xff])]))
  const [, rep, , atyp] = await r.read(4)
  if (rep !== 0) throw new Error(`SOCKS5 connect failed: ${SOCKS_ERRORS[rep] ?? `code ${rep}`}`)
  const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : (await r.read(1))[0]
  await r.read(addrLen + 2)
  r.done()
}

// Opens a raw TCP stream to host:port through the proxy.
async function openTunnel(proxy, host, port, signal) {
  const p = new URL(proxy)
  const socks = p.protocol.startsWith("socks")
  const pport = Number(p.port) || (socks ? 1080 : p.protocol === "https:" ? 443 : 80)
  const sock =
    p.protocol === "https:"
      ? tls.connect({ host: p.hostname, port: pport, servername: net.isIP(p.hostname) ? undefined : p.hostname })
      : net.connect(pport, p.hostname)
  let reject
  const failed = new Promise((_, j) => (reject = j))
  failed.catch(() => {})
  const onError = (err) => reject(err)
  const onClose = () => reject(new Error("proxy closed the connection"))
  const onAbort = () => reject(signal.reason ?? new Error("aborted"))
  const timer = setTimeout(() => reject(new Error("proxy handshake timed out")), PROXY_CONNECT_TIMEOUT_MS)
  sock.once("error", onError)
  sock.once("close", onClose)
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    await Promise.race([new Promise((r) => sock.once(p.protocol === "https:" ? "secureConnect" : "connect", r)), failed])
    await Promise.race([(socks ? socks5Handshake : httpConnectHandshake)(sock, p, host, port), failed])
    return sock
  } catch (err) {
    sock.destroy()
    throw err
  } finally {
    clearTimeout(timer)
    sock.off("error", onError)
    sock.off("close", onClose)
    signal?.removeEventListener("abort", onAbort)
  }
}

// fetch() over a proxy tunnel. Supports the subset of fetch the upstream calls
// use: string body, plain-object headers, an AbortSignal.
async function proxiedFetch(proxy, url, init = {}) {
  const target = new URL(url)
  const secure = target.protocol === "https:"
  const port = Number(target.port) || (secure ? 443 : 80)
  const signal = init.signal
  if (signal?.aborted) throw signal.reason ?? new Error("aborted")
  let sock = await openTunnel(proxy, target.hostname, port, signal)
  // The reader left it paused; nothing arrives before our request is written,
  // so handing it over flowing loses no bytes.
  sock.resume()
  if (secure) {
    sock = tls.connect({ socket: sock, servername: net.isIP(target.hostname) ? undefined : target.hostname, ALPNProtocols: ["http/1.1"] })
  }
  const headers = { ...init.headers, host: target.host }
  // fetch() decompresses for its callers; this path does not, so ask for identity.
  delete headers["accept-encoding"]
  if (init.body != null) headers["content-length"] = Buffer.byteLength(init.body)
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: init.method ?? "GET",
      path: target.pathname + target.search,
      headers,
      createConnection: () => sock,
      signal,
    })
    req.on("error", (err) => {
      sock.destroy()
      reject(err)
    })
    req.on("response", (res) => {
      const out = new Headers()
      for (const [k, v] of Object.entries(res.headers)) out.set(k, Array.isArray(v) ? v.join(", ") : v)
      const noBody = [204, 205, 304].includes(res.statusCode) || req.method === "HEAD"
      // Hand-built rather than Readable.toWeb so cancel() reliably hangs up the
      // tunnel on every supported Node — probes rely on that.
      const body = noBody
        ? null
        : new ReadableStream({
            start(c) {
              res.on("data", (d) => c.enqueue(new Uint8Array(d)))
              res.on("end", () => { try { c.close() } catch {} })
              res.on("error", (e) => { try { c.error(e) } catch {} })
            },
            cancel() {
              res.destroy()
              sock.destroy()
            },
          })
      if (noBody) res.resume()
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage, headers: out }))
    })
    req.end(init.body ?? undefined)
  })
}

const proxyState = new Map()
const proxySticky = new Map()
let proxyCursor = 0
function proxyStat(url) {
  let st = proxyState.get(url)
  if (!st) proxyState.set(url, (st = { uses: 0, fails: 0, cooldownUntil: 0, lastError: "", lastMs: 0, lastStatus: 0 }))
  return st
}

function proxyCooldown(url, why) {
  const st = proxyStat(url)
  st.fails++
  st.lastError = why
  st.cooldownUntil = Date.now() + Math.max(0, Number(config.proxyCooldownMs) || 0)
  log(`proxy ${maskProxy(url)} cooling down: ${why}`)
}

// Next live proxy in list order from the cursor, skipping ones in cooldown.
function nextRoundRobin(list, live) {
  for (let i = 0; i < list.length; i++) {
    const u = list[(proxyCursor + i) % list.length]
    if (live.includes(u)) {
      proxyCursor = (proxyCursor + i + 1) % list.length
      return u
    }
  }
}

function pickProxy(key = "server", now = Date.now()) {
  const list = config.proxies ?? []
  const live = list.filter((u) => proxyStat(u).cooldownUntil <= now)
  if (!live.length) {
    const err = new Error(`all ${list.length} proxies are cooling down`)
    err.code = "NO_PROXY"
    throw err
  }
  switch (config.proxyStrategy) {
    case "random":
      return live[Math.floor(Math.random() * live.length)]
    case "failover":
      return live[0]
    case "least-used":
      return live.reduce((a, b) => (proxyStat(b).uses < proxyStat(a).uses ? b : a))
    case "sticky": {
      const pinned = proxySticky.get(key)
      if (pinned && live.includes(pinned)) return pinned
      const next = nextRoundRobin(list, live)
      proxySticky.set(key, next)
      return next
    }
    default:
      return nextRoundRobin(list, live)
  }
}

// Every upstream call goes through here. No proxies configured (or a health
// check while proxyHealthChecks is "direct") means plain fetch, untouched.
// A network failure or a 429 benches the proxy for proxyCooldownMs; the caller's
// retry loop then naturally lands on the next one. 403s are request-shape
// verdicts from the gate, not the IP's fault, so they never cool a proxy.
async function upstreamFetch(url, init = {}, { req, health = false, proxy } = {}) {
  const list = config.proxies ?? []
  if (!proxy && (!list.length || (health && config.proxyHealthChecks === "direct"))) return fetch(url, init)
  const chosen = proxy ?? pickProxy(req ? sessionFor(req).value : "server")
  const st = proxyStat(chosen)
  st.uses++
  const t0 = Date.now()
  try {
    const r = await proxiedFetch(chosen, url, init)
    st.lastMs = Date.now() - t0
    st.lastStatus = r.status
    if (r.status === 429) proxyCooldown(chosen, "upstream 429 (rate limited)")
    return r
  } catch (err) {
    if (!init.signal?.aborted) proxyCooldown(chosen, err.message)
    throw err
  }
}

function proxyStatus(now = Date.now()) {
  return {
    strategy: config.proxyStrategy,
    cooldownMs: config.proxyCooldownMs,
    healthChecks: config.proxyHealthChecks,
    strategies: PROXY_STRATEGIES,
    proxies: (config.proxies ?? []).map((url) => {
      const st = proxyStat(url)
      return {
        id: proxyId(url),
        url: maskProxy(url),
        uses: st.uses,
        fails: st.fails,
        lastMs: st.lastMs,
        lastStatus: st.lastStatus,
        lastError: st.lastError,
        coolingMs: Math.max(0, st.cooldownUntil - now),
      }
    }),
  }
}

// Request bodies get big in real sessions: Claude Code's compaction POSTs the
// whole transcript (base64 images included) and upstream itself accepted a 30MB
// probe untouched. The old 1MB ceiling turned those requests into 413s, which
// Claude Code surfaces as "request size limit reached" and abandons the session.
// The default mirrors Anthropic's own 32MB guidance; `maxBodyBytes` overrides it.
const MAX_BODY = 32 * 1024 * 1024

const DEFAULT_CONFIG = {
  host: ENV.HOST ?? "127.0.0.1",
  port: Number(ENV.PORT ?? 8787),
  upstream: normalizeUpstream(ENV.ZEN_URL ?? DEFAULT_UPSTREAM),
  ua: ENV.ZEN_UA ?? "opencode/1.18.30",
  autoUA: ENV.AUTO_UA !== "0",
  uaRefreshMs: Number(ENV.UA_REFRESH_MS ?? 6 * 3600_000),
  injectSession: ENV.INJECT_SESSION !== "0",
  // Which credentials the auto-sync health probe uses:
  //   "auto"      — use defaultZenKey when set, otherwise anonymous `public`
  //   "key"       — always use defaultZenKey (probe fails if none is set)
  //   "anonymous" — always anonymous `public`, even when a key is configured
  probeAuth: ENV.PROBE_AUTH ?? "auto",
  // "" = auto: at request time the first *healthy* free model becomes the default
  // (see effectiveDefault), so a model that disappears upstream never bricks new
  // installs. Set an explicit model here to pin it.
  defaultModel: ENV.DEFAULT_MODEL ?? "",
  fallbackModels: JSON.parse(ENV.FALLBACK_MODELS ?? JSON.stringify(loadShippedModels())),
  modelAliases: JSON.parse(ENV.MODEL_ALIASES ?? "{}"),
  // Prepended to Anthropic /v1/messages system prompts so the free tier accepts
  // the request. The client's own instructions are kept intact after it.
  // Set to "" (or AGENT_PREAMBLE=0) to send requests unadorned.
  // Optional extra preamble prepended to Anthropic /v1/messages system prompts.
  // Off by default: shipping opencode's agent tools (agentTools, below) is what
  // makes the free tier accept the request, and combining the two measures was
  // measured to *break* requests that the tool bridge alone gets through.
  agentPreamble: ENV.AGENT_PREAMBLE ?? "",
  // Append opencode's own tools to Anthropic /v1/messages requests so the free
  // tier accepts them. Calls to them are renamed back to the caller's tools.
  agentTools: ENV.AGENT_TOOLS !== "0",
  // opencode Zen serves each model on a specific endpoint family
  // (chat/completions | responses | messages). Patterns may end in `*`.
  // Source of truth: https://opencode.ai/docs/zen
  responsesModels: JSON.parse(
    ENV.RESPONSES_MODELS ??
      JSON.stringify(["gpt-5*", "gpt-6*", "grok-*", "muse-spark-*"]),
  ),
  maxBodyBytes: Number(ENV.MAX_BODY_BYTES ?? MAX_BODY),
  // How many extra attempts a request gets against the *same* model when it
  // fails transiently (429/5xx/network) before the fallback chain moves on.
  retriesPerModel: Number(ENV.RETRIES_PER_MODEL ?? 2),
  retryBackoffMs: Number(ENV.RETRY_BACKOFF_MS ?? 500),
  rateLimitMax: Number(ENV.RATE_LIMIT_MAX ?? 0),
  rateLimitWindowMs: Number(ENV.RATE_LIMIT_WINDOW_MS ?? 60_000),
  proxyKey: ENV.PROXY_KEY ?? "",
  defaultZenKey: ENV.ZEN_KEY ?? "",
  trustForwarded: ENV.TRUST_FORWARDED === "1",
  timeoutMs: Number(ENV.TIMEOUT_MS ?? 120000),
  cacheMs: Number(ENV.CACHE_MS ?? 30000),
  autoSync: ENV.AUTO_SYNC !== "0",
  autoSyncIntervalMs: Number(ENV.AUTO_SYNC_MS ?? 3600000),
  // Outbound proxy pool for upstream traffic (see upstreamFetch). Managed from
  // the dashboard's Proxies tab or /api/proxies; PROXIES takes a comma list.
  proxies: parseProxyList(ENV.PROXIES ?? "").proxies,
  proxyStrategy: PROXY_STRATEGIES.includes(ENV.PROXY_STRATEGY) ? ENV.PROXY_STRATEGY : "round-robin",
  proxyCooldownMs: Number(ENV.PROXY_COOLDOWN_MS ?? 60_000),
  // "proxy" = model probes, sync, /health and dashboard tests use the pool too;
  // "direct" = they go straight out, so you can tell a dead model from a dead proxy.
  proxyHealthChecks: ENV.PROXY_HEALTH_CHECKS === "direct" ? "direct" : "proxy",
}

// True when the user's own config carries an explicit model list. While it is
// false the list comes from models.json, so catalog refreshes reach installs that
// never touched the setting. It flips to true the moment someone edits the list
// in the dashboard (or sets FALLBACK_MODELS), and "Restore defaults" flips it
// back.
let fallbackModelsPinned = false

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    const merged = { ...DEFAULT_CONFIG, ...raw }
    // A config file that predates the models.json catalog still holds a list
    // written by an older build. Those are only ever subsets of what we shipped
    // (the runtime sync used to prune dead entries and save the result), so
    // treat them as "never edited" and go back to following models.json —
    // otherwise an existing install would be pinned to a frozen list forever and
    // never see a catalog refresh. Anyone who really wants their own list can
    // re-pin it from the dashboard, which re-adds the key.
    const pinnedList = Array.isArray(raw.fallbackModels) ? raw.fallbackModels.filter((m) => typeof m === "string") : null
    const looksShipped = pinnedList != null && pinnedList.length > 0 && pinnedList.every((m) => BAKED_MODELS.includes(m))
    if (looksShipped) {
      merged.fallbackModels = loadShippedModels()
      fallbackModelsPinned = false
      try {
        // Written straight to disk rather than through saveConfig: loadConfig
        // runs while `config` is still being initialised, so saveConfig cannot
        // read it yet.
        writeConfigFile({ ...raw, fallbackModels: undefined })
        log("model list now follows models.json (was a default list from an older build)")
      } catch {}
    } else {
      fallbackModelsPinned = pinnedList != null && pinnedList.length > 0
      if (!fallbackModelsPinned) merged.fallbackModels = loadShippedModels()
    }
    // Older installs (and the shipped zen-proxy.json) still name the legacy
    // `/zen/v1` base, which upstream now gates. Upgrade it in place so an
    // existing config file keeps working after an update.
    const parsedProxies = parseProxyList(merged.proxies)
    merged.proxies = parsedProxies.proxies
    for (const e of parsedProxies.errors) log(`config: ignoring proxy — ${e}`)
    const upstream = normalizeUpstream(merged.upstream)
    if (upstream !== merged.upstream) {
      merged.upstream = upstream
      try {
        writeConfigFile({ ...raw, upstream })
        log(`upstream migrated to ${upstream} (the legacy /zen/v1 base is no longer served)`)
      } catch {}
    }
    return merged
  } catch {
    fallbackModelsPinned = false
    return { ...DEFAULT_CONFIG, fallbackModels: loadShippedModels() }
  }
}

let config = loadConfig()
let uiHtml = ""
try {
  uiHtml = fs.readFileSync(UI_PATH, "utf8")
} catch {}

let reloading = false
if (isMain) {
  try {
    const CONFIG_NAME = path.basename(CONFIG_PATH)
    fs.watch(path.dirname(CONFIG_PATH), (_event, filename) => {
      if (reloading) return
      if (filename && filename !== CONFIG_NAME && filename !== CONFIG_NAME + ".tmp") return
      reloading = true
      setTimeout(() => {
        config = loadConfig()
        reloading = false
        scheduleSync()
        scheduleUA()
        log("config reloaded")
      }, 150)
    })
  } catch {}
}

function isFallbackModelsPinned() {
  return fallbackModelsPinned
}

function writeConfigFile(obj) {
  fs.writeFileSync(CONFIG_PATH + ".tmp", JSON.stringify(obj, null, 2))
  fs.renameSync(CONFIG_PATH + ".tmp", CONFIG_PATH)
}

function saveConfig(next) {
  const merged = { ...config, ...next }
  // Passing `fallbackModels: undefined` means "drop the pinned list and follow
  // models.json again". JSON.stringify omits undefined values, so the key is
  // removed from the file while memory keeps the shipped list in use.
  const unpin = next && "fallbackModels" in next && next.fallbackModels === undefined
  if (unpin) {
    merged.fallbackModels = loadShippedModels()
    fallbackModelsPinned = false
  }
  // While the list is following models.json it must stay out of the config file:
  // any unrelated save (an auto-UA refresh, a key change) would otherwise merge
  // the in-memory list back to disk and silently pin this install to whatever
  // the catalog said today.
  const forDisk = unpin || !fallbackModelsPinned ? { ...merged, fallbackModels: undefined } : merged
  writeConfigFile(forDisk)
  config = merged
  return merged
}

function maskKey(k) {
  if (!k) return ""
  if (k.length <= 12) return "••••••••"
  return k.slice(0, 6) + "••••••" + k.slice(-4)
}

function sanitize(cfg) {
  const out = { ...cfg }
  if (out.proxyKey) out.proxyKey = "••••••••"
  if (out.defaultZenKey) out.defaultZenKey = maskKey(out.defaultZenKey)
  out.proxies = (out.proxies ?? []).map(maskProxy)
  return out
}

const ALLOWED = () => new Set([...config.fallbackModels, ...Object.values(config.modelAliases)])
const requestStats = { total: 0, errors: 0, recent: [], perMinute: new Map(), window60: [] }
// jev-* free models are served on /v1/systemone (structured classification),
// not on a chat/responses endpoint, so they are never routable here.
const NOT_CHAT_SERVABLE = [/^jev-/]

// opencode's free tier requires every request to carry session identity: upstream
// returns 400 `MissingSessionID` with no session header, and 403 `FreeTierError`
// when only one of the pair is present. The real CLI sends BOTH headers with the
// same value, so we mint stable per-client session IDs and inject both.
// Generic agents send neither, which is why the proxy has to add them.
//
// The ID itself has to look like a real one. Upstream decodes the leading 12 hex
// characters as a creation timestamp and rejects IDs that do not carry a plausible
// one (`403 FreeTierError`, the same error as a missing header), so a naive
// `ses_<random hex>` is refused. This mirrors the generator opencode itself uses:
// `ses_` + 12 hex digits of ~(ms * 0x1000 + counter) + 14 random base62 chars.
// The trailing characters are random and not checked; the leading 12 are.
const SESSION_HEADERS = ["x-opencode-session", "x-opencode-session-id"]
const SESSION_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
// A session stays valid as long as its embedded timestamp is recent. Re-mint on a
// schedule so a proxy left running for days does not start failing on a stale ID.
const SESSION_MAX_AGE_MS = 30 * 60_000
const sessionPool = new Map()
let sessionClock = { ms: 0, ctr: 0 }
function genSessionId(now = Date.now()) {
  if (now !== sessionClock.ms) {
    sessionClock.ms = now
    sessionClock.ctr = 0
  }
  sessionClock.ctr++
  const stamp = BigInt(now) * 0x1000n + BigInt(sessionClock.ctr)
  const masked = ~stamp
  const hex = Array.from({ length: 6 }, (_, i) => Number(masked >> BigInt(40 - 8 * i) & 0xffn).toString(16).padStart(2, "0")).join("")
  const tail = Array.from(randomBytes(14), (b) => SESSION_ALPHABET[b % 62]).join("")
  return { value: "ses_" + hex + tail, at: now }
}
function sessionFor(req) {
  const incoming = req?.headers?.["x-opencode-session"]
  if (typeof incoming === "string" && incoming.trim()) return { value: incoming.trim(), injected: false }
  const key = req ? (ipOmit(clientIp(req)) ? "local" : clientIp(req)) : "server"
  let hit = sessionPool.get(key)
  if (!hit || Date.now() - hit.at > SESSION_MAX_AGE_MS) {
    hit = genSessionId()
    sessionPool.set(key, hit)
  }
  return { value: hit.value, injected: true }
}
function sessionHeader(req) {
  if (!config.injectSession) return undefined
  return sessionFor(req).value
}

function parseRetryAfter(v) {
  if (v == null) return 0
  const n = Number(v)
  if (Number.isFinite(n)) return Math.max(0, n)
  const t = Date.parse(v)
  if (Number.isFinite(t)) return Math.max(0, (t - Date.now()) / 1000)
  return 0
}

const RETRYABLE_ERROR_TYPES = new Set([
  "server_error",
  "api_error",
  "upstream_error",
  "ProviderError",
  "ModelError",
  "MissingSessionID",
  "RegionError",
  "FreeTierError",
  "model_not_found",
])
// Free-tier backends fail with 4xx errors that are really per-model / per-provider
// conditions (console says "Model is unavailable", "not supported", geo blocks…).
// Those are not client bugs — the proxy should roll to the next candidate instead
// of surfacing a hard 4xx. Real request errors (bad JSON, auth, context length…)
// still break out immediately.
function retryableUpstream(status, body) {
  if (status === 429 || status >= 500) return true
  // 410 Gone is what a retired model id returns; auto-sync may not have caught
  // up yet, so the chain has to keep walking instead of surfacing "deprecated".
  if (status === 410) return true
  if (status < 400 || status > 499) return false
  const t = body?.error?.type ?? body?.type ?? ""
  const msg = String(body?.error?.message ?? body?.message ?? "")
  if (RETRYABLE_ERROR_TYPES.has(t)) return true
  return /model is unavailable|not supported|only be used in opencode|free tier can only|no such model|does not exist|has been deprecated|no longer available|overloaded|temporarily.*limit|upstream request failed/i.test(msg)
}

// Transient means waiting and asking the *same* model again can plausibly
// succeed (provider hiccup, rate limit, network blip). Model-level verdicts —
// free-tier gate 403s, geo blocks, retired ids — are deterministic, so those
// skip straight to the next candidate rather than burning retries on a
// foregone conclusion.
function transientUpstream(status, body) {
  if (status === 429 || status >= 500) return true
  const t = body?.error?.type ?? body?.type ?? ""
  return t === "server_error" || t === "api_error" || t === "upstream_error" || t === "ProviderError"
}

// ---- endpoint family resolution -------------------------------------------
// Zen serves each model on one endpoint family. We translate to/from the
// Responses API ourselves instead of pattern-matching a single vendor in code,
// so new models work by adding a pattern to `responsesModels` in config.
function modelFormat(id) {
  const s = String(id ?? "")
  for (const p of config.responsesModels ?? []) {
    if (typeof p !== "string" || !p) continue
    if (p.endsWith("*") ? s.startsWith(p.slice(0, -1)) : s === p) return "responses"
  }
  return "chat"
}

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : (p?.text ?? p?.content ?? p?.input_text ?? "")))
      .filter(Boolean)
      .join("")
  }
  return content == null ? "" : String(content)
}

// ---- Anthropic -> chat.completions -----------------------------------------
// Anthropic puts the system prompt at the top level as an array of blocks and
// models tool use inside message content, so a body has to be reshaped before
// it means the same thing on a chat endpoint.
function anthropicSystemText(system) {
  if (!system) return ""
  if (typeof system === "string") return system
  if (!Array.isArray(system)) return String(system)
  return system.map((b) => (typeof b === "string" ? b : (b?.text ?? ""))).filter(Boolean).join("\n\n")
}

// An Anthropic image block carries raw base64; OpenAI-compatible chat endpoints
// want a data: URL in an image_url part.
function anthropicImageUrl(block) {
  const src = block?.source
  if (!src) return null
  if (src.type === "url" && typeof src.url === "string") return src.url
  if (src.type === "base64" && typeof src.data === "string") return `data:${src.media_type ?? "image/png"};base64,${src.data}`
  return null
}

function anthropicToChatMessages(system, messages) {
  const out = []
  const preamble = String(config.agentPreamble ?? AGENT_PREAMBLE_TEXT ?? "")
  const sysText = anthropicSystemText(system)
  // Preamble and the client's instructions go into a *single* system message,
  // preamble first. One message is what the upstream gate was measured against;
  // splitting them into two separate system turns is accepted differently.
  // Nothing the client sent is dropped or reordered — it all still follows.
  const combined = preamble && sysText ? `${preamble}\n\n${sysText}` : preamble || sysText
  if (combined) out.push({ role: "system", content: combined })

  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role === "assistant" ? "assistant" : "user"
    if (typeof m?.content === "string") {
      out.push({ role, content: m.content })
      continue
    }
    const blocks = Array.isArray(m?.content) ? m.content : []
    const toolCalls = []
    const parts = []
    // A tool_result is its own chat message with role "tool", not part of the
    // surrounding user turn, so those are flushed out first.
    const flush = () => {
      // `parts` holds block objects, so text has to be unwrapped before joining.
      const text = parts.filter((p) => p?.type === "text" && p.text).map((p) => p.text).join("")
      const images = parts.filter((p) => p?.type === "image_url").map((p) => ({ type: "image_url", image_url: p.image_url }))
      if (text || images.length) {
        out.push({ role, content: images.length ? [...(text ? [{ type: "text", text }] : []), ...images] : text })
      }
      parts.length = 0
    }
    for (const b of blocks) {
      const type = b?.type
      if (type === "text") parts.push({ type: "text", text: b.text ?? "" })
      else if (type === "image") {
        const url = anthropicImageUrl(b)
        if (url) parts.push({ type: "image_url", image_url: { url } })
      } else if (type === "tool_use") {
        toolCalls.push({
          id: b.id ?? "call_0",
          type: "function",
          function: { name: b.name ?? "unknown", arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {}) },
        })
      } else if (type === "tool_result") {
        flush()
        // A tool result may carry images: Claude Code's Read on a picture sends
        // an image block inside the tool_result, and nothing else. Chat
        // endpoints reject images in role "tool", so the text stays on the tool
        // message and the pictures follow as a user turn — the same shape the
        // Responses translation already uses. Without this the model only saw
        // an empty text fallback and the picture silently vanished.
        const images = Array.isArray(b.content)
          ? b.content.filter((p) => p?.type === "image").map(anthropicImageUrl).filter(Boolean)
          : []
        out.push({
          role: "tool",
          tool_call_id: b.tool_use_id ?? b.id ?? "call_0",
          content: typeof b.content === "string" ? b.content : textOf(b.content) || " ",
        })
        if (images.length) out.push({ role: "user", content: images.map((url) => ({ type: "image_url", image_url: { url } })) })
      }
    }
    flush()
    if (toolCalls.length) out.push({ role: "assistant", content: "", tool_calls: toolCalls })
  }
  if (!out.length) out.push({ role: "user", content: "" })
  return out
}

function anthropicToolsToChat(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined
  const out = []
  for (const t of tools) {
    if (!t?.name) continue
    out.push({
      type: "function",
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    })
  }
  return out.length ? out : undefined
}

function anthropicToChatBody(body, model) {
  const payload = {
    model,
    messages: anthropicToChatMessages(body?.system, body?.messages),
    stream: !!body?.stream,
  }
  const mt = Number(body?.max_tokens)
  if (Number.isFinite(mt) && mt > 0) payload.max_tokens = Math.floor(mt)
  if (body?.temperature != null) payload.temperature = body.temperature
  if (body?.top_p != null) payload.top_p = body.top_p
  if (Array.isArray(body?.stop_sequences) && body.stop_sequences.length) payload.stop = body.stop_sequences.slice(0, 4)
  const tools = anthropicToolsToChat(body?.tools)
  // Ship opencode's own tools ahead of the caller's. Without them the free tier
  // rejects the request outright; the caller's prompt and tools are untouched and
  // still take priority in the reply.
  const bridge = agentToolsFor((body?.tools ?? []).map((t) => t?.name))
  const all = bridge.length ? [...bridge, ...(tools ?? [])] : tools
  if (all?.length) payload.tools = all
  // Anthropic's tool_choice and opencode's use the same vocabulary once renamed.
  if (typeof body?.tool_choice === "object" && body.tool_choice?.type === "tool") {
    payload.tool_choice = { type: "function", function: { name: body.tool_choice.name } }
  } else if (typeof body?.tool_choice === "string") {
    payload.tool_choice = body.tool_choice
  }
  return payload
}

// ---- chat.completions -> Anthropic message ----------------------------------
function parseToolArgs(args) {
  if (typeof args !== "string") return args ?? {}
  try {
    const v = JSON.parse(args)
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

const STOP_REASON = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "end_turn" }

function chatToAnthropic(content, requested, servedBy) {
  const msg = content?.choices?.[0]?.message ?? {}
  const blocks = []
  if (msg.reasoning_content) blocks.push({ type: "thinking", thinking: msg.reasoning_content, signature: "" })
  const text = typeof msg.content === "string" ? msg.content : textOf(msg.content)
  if (text) blocks.push({ type: "text", text })
  for (const tc of msg.tool_calls ?? []) {
    // A call to an opencode bridge tool comes back under opencode's name; give
    // the caller back the tool it actually offered.
    const mapped = remapAgentTool(tc?.function?.name ?? tc?.name, tc?.function?.arguments ?? tc?.arguments)
    blocks.push({
      type: "tool_use",
      id: tc?.id ?? `toolu_${randomBytes(8).toString("hex")}`,
      name: mapped ? mapped.name : (tc?.function?.name ?? tc?.name ?? "unknown"),
      input: parseToolArgs(mapped ? mapped.args : (tc?.function?.arguments ?? tc?.arguments)),
    })
  }
  if (!blocks.length) blocks.push({ type: "text", text: "" })
  const u = content?.usage ?? {}
  return {
    id: content?.id ?? `msg_${randomBytes(12).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: requested,
    content: blocks,
    stop_reason: STOP_REASON[content?.choices?.[0]?.finish_reason] ?? "end_turn",
    stop_sequence: null,
    usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 },
    ...(servedBy && servedBy !== requested ? { zen_served_by: servedBy } : {}),
  }
}

// Anthropic errors are `{type:"error", error:{type,message}}`; upstream speaks
// OpenAI shapes, so translate the ones clients actually branch on.
const ANTHROPIC_ERROR_TYPE = {
  invalid_request_error: "invalid_request_error",
  authentication_error: "authentication_error",
  permission_error: "permission_error",
  not_found_error: "not_found_error",
  request_too_large: "request_too_large",
  rate_limit_error: "rate_limit_error",
  api_error: "api_error",
  overload_error: "overloaded_error",
}
const ANTHROPIC_ERROR_MAP = {
  FreeTierError: "permission_error",
  RegionError: "permission_error",
  MissingSessionID: "api_error",
  AuthError: "authentication_error",
  model_not_found: "not_found_error",
  server_error: "api_error",
  ProviderError: "api_error",
  ModelError: "api_error",
}
function anthropicError(status, err) {
  const type = String(err?.error?.type ?? err?.type ?? "")
  const resolved =
    ANTHROPIC_ERROR_MAP[type] ??
    ANTHROPIC_ERROR_TYPE[type] ??
    (status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : status >= 500 ? "api_error" : "invalid_request_error")
  return { status, body: { type: "error", error: { type: resolved, message: String(err?.error?.message ?? err?.message ?? "request failed") } } }
}

// chat.completions messages -> Responses API `input` items.
// Keeps tool calls and tool results as first-class items so agent tool loops
// survive the translation (the naive "join everything into one string" approach
// silently destroys them).
function chatMessagesToInput(messages) {
  if (!Array.isArray(messages)) return String(messages ?? "")
  const items = []
  for (const m of messages) {
    const role = m?.role ?? "user"
    if (role === "tool" || role === "function") {
      const callId = m?.tool_call_id ?? m?.call_id ?? m?.id ?? "call_0"
      items.push({
        type: "function_call_output",
        call_id: callId,
        output: textOf(m?.content) || " ",
      })
      // Images inside tool results survive as a follow-up user input_image item.
      if (Array.isArray(m?.content)) {
        const imgs = m.content.filter((p) => p?.type === "image_url" && p?.image_url?.url)
        if (imgs.length) {
          items.push({ role: "user", content: imgs.map((p) => ({ type: "input_image", image_url: p.image_url.url })) })
        }
      }
      continue
    }
    // Preserve image_url parts as Responses input_image content blocks.
    if (Array.isArray(m?.content)) {
      const parts = []
      let hasImage = false
      for (const p of m.content) {
        if (typeof p === "string") { if (p) parts.push({ type: "input_text", text: p }) }
        else if (p?.type === "text" && p.text) parts.push({ type: "input_text", text: p.text })
        else if (p?.type === "image_url" && p?.image_url?.url) {
          parts.push({ type: "input_image", image_url: p.image_url.url })
          hasImage = true
        }
      }
      if (hasImage && parts.length) {
        items.push({ role: role === "assistant" ? "assistant" : role, content: parts })
        for (const tc of m?.tool_calls ?? []) {
          items.push({
            type: "function_call",
            call_id: tc?.id ?? "call_0",
            name: tc?.function?.name ?? tc?.name ?? "unknown",
            arguments: tc?.function?.arguments ?? tc?.arguments ?? "{}",
          })
        }
        continue
      }
    }
    const text = textOf(m?.content)
    if (text) items.push({ role: role === "assistant" ? "assistant" : role, content: text })
    for (const tc of m?.tool_calls ?? []) {
      items.push({
        type: "function_call",
        call_id: tc?.id ?? "call_0",
        name: tc?.function?.name ?? tc?.name ?? "unknown",
        arguments: tc?.function?.arguments ?? tc?.arguments ?? "{}",
      })
    }
  }
  return items.length ? items : [{ role: "user", content: "" }]
}

function chatToolsToResponses(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const t of tools) {
    const fn = t?.type === "function" ? (t.function ?? t) : null
    if (!fn?.name) continue
    out.push({
      type: "function",
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      ...(fn.parameters ? { parameters: fn.parameters } : {}),
      ...(fn.strict != null ? { strict: fn.strict } : {}),
    })
  }
  return out.length ? out : undefined
}

// Responses API result -> chat.completion, preserving tool calls + reasoning.
function responsesToChat(data, requested, servedBy) {
  const output = Array.isArray(data?.output) ? data.output : []
  let text = typeof data?.output_text === "string" ? data.output_text : ""
  if (!text) {
    const parts = []
    for (const item of output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) if (c?.type === "output_text" && c.text) parts.push(c.text)
      }
    }
    text = parts.join("")
  }
  const toolCalls = output
    .filter((i) => i?.type === "function_call")
    .map((i, n) => ({
      id: i.call_id ?? i.id ?? `call_${n}`,
      type: "function",
      function: { name: i.name ?? "unknown", arguments: typeof i.arguments === "string" ? i.arguments : JSON.stringify(i.arguments ?? {}) },
    }))
  const reasoning = output
    .filter((i) => i?.type === "reasoning")
    .flatMap((i) => (Array.isArray(i.summary) ? i.summary.map((s) => s?.text ?? "") : []))
    .filter(Boolean)
    .join("\n")
  const u = data?.usage ?? {}
  const message = { role: "assistant", content: text || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    id: data?.id ?? `chatcmpl-${randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requested,
    ...(servedBy && servedBy !== requested ? { zen_served_by: servedBy } : {}),
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : data?.status === "incomplete" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    },
  }
}

// Responses SSE event -> chat.completion.chunk deltas.
function responsesEventToDeltas(event, data, state) {
  const type = event || data?.type || ""
  const out = []
  if (type === "response.output_text.delta" && data?.delta) out.push({ content: data.delta })
  else if ((type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") && data?.delta)
    out.push({ reasoning_content: data.delta })
  else if (type === "response.output_item.added" && data?.item?.type === "function_call") {
    const item = data.item
    const index = state.tools.length
    state.tools.push({ id: item.call_id ?? item.id ?? `call_${index}` })
    out.push({ tool_calls: [{ index, id: item.call_id ?? item.id ?? `call_${index}`, type: "function", function: { name: item.name ?? "unknown", arguments: "" } }] })
  } else if (type === "response.function_call_arguments.delta" && data?.delta) {
    let index = state.tools.findIndex((t) => t.id === (data.item_id ?? data.call_id ?? data.call_id))
    if (index < 0) index = 0
    if (!state.tools[index]) state.tools[index] = { id: data.call_id ?? `call_${index}` }
    out.push({ tool_calls: [{ index, function: { arguments: data.delta } }] })
  }
  return out
}

function usageToChat(u = {}) {
  return {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
  }
}

function toBool(v, dflt) {
  if (v === undefined || v === null) return dflt
  if (v === false || v === 0 || v === "0" || v === "false") return false
  return true
}

function num(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}
const syncState = { at: 0, ok: false, running: false, working: [], rateLimited: [], flaky: [], gated: [], dead: [], error: "", ms: 0 }
// Health learned from real client traffic, kept alongside the agent-shaped
// probe in probeModel(). Real traffic is the ground truth: it can disagree
// with a probe when a gate lifts or a quota refills mid-cycle.
const observed = new Map()
function recordObserved(model, ok) {
  if (!model) return
  const cur = observed.get(model) ?? { ok: 0, fail: 0, last: 0 }
  if (ok) cur.ok++
  else cur.fail++
  cur.last = Date.now()
  observed.set(model, cur)
}
const modelHealth = new Map()
const MAX_LOG = 500
const logLines = []
function log(message) {
  const line = { at: new Date().toISOString(), msg: message }
  logLines.push(line)
  if (logLines.length > MAX_LOG) logLines.shift()
  console.log(line.msg)
}

function recordReq(req, model, ms, status, at = Date.now()) {
  const entry = { at, ip: clientIp(req), model, status, ms }
  const key = `${entry.at}|${entry.model}|${entry.status}`
  if (!requestStats.recent.length || requestStats.recent[requestStats.recent.length - 1][0] !== key) {
    requestStats.recent.push([key, 1, ms])
    if (requestStats.recent.length > 200) requestStats.recent.shift()
  } else {
    requestStats.recent[requestStats.recent.length - 1][1]++
    requestStats.recent[requestStats.recent.length - 1][2] = ms
  }
  requestStats.total++
  if (status >= 400) requestStats.errors++
  const minute = Math.floor(entry.at / 60000)
  requestStats.perMinute.set(minute, (requestStats.perMinute.get(minute) ?? 0) + 1)
  const cutoff = entry.at - 60_000
  while (requestStats.window60.length && requestStats.window60[0] < cutoff) requestStats.window60.shift()
  requestStats.window60.push(entry.at)
  const minCutoff = minute - 60
  for (const m of [...requestStats.perMinute.keys()]) {
    if (m < minCutoff) requestStats.perMinute.delete(m)
  }
}

// Effective default model: an explicit config.defaultModel always wins; when it's
// empty (auto), prefer the first fallback model the last auto-sync saw as healthy
// so a dead hardcoded default never stalls requests.
function effectiveDefault() {
  if (config.defaultModel) return config.defaultModel
  const synced = new Set([...(syncState.working ?? []), ...(syncState.rateLimited ?? [])])
  for (const m of config.fallbackModels) if (synced.has(m)) return m
  return config.fallbackModels[0] ?? ""
}

function resolveModel(requested) {
  const dflt = effectiveDefault()
  const id = String(requested ?? "").split("/").pop()
  const target = config.modelAliases[id] || (ALLOWED().has(id) ? id : "") || dflt
  const rest = config.fallbackModels.filter((m) => m !== target)
  return { requested: id || dflt, candidates: [target, ...rest] }
}

function clientIp(req) {
  if (config.trustForwarded) {
    const xff = req.headers["x-forwarded-for"]
    if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim()
    const xri = req.headers["x-real-ip"]
    if (typeof xri === "string" && xri.trim()) return xri.trim()
  }
  return req.socket.remoteAddress ?? ""
}

function ipOmit(ip) {
  if (!ip) return true
  const v = ip.replace(/^::ffff:/, "").toLowerCase()
  if (v === "::1" || v === "localhost" || v === "127.0.0.1" || /^127\./.test(v)) return true
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v)) return true
  if (/^fe80:/.test(v) || /^fc/.test(v) || /^fd/.test(v)) return true
  return false
}

function zenHeaders(req, auth) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: auth,
    "user-agent": config.ua,
  }
  const sess = sessionFor(req)
  // Send both session headers whenever we are allowed to supply one. A client
  // that brings its own session keeps it; we just mirror it into the second
  // header so the pair upstream expects is always complete.
  if (!sess.injected || config.injectSession) {
    for (const h of SESSION_HEADERS) headers[h] = sess.value
  }
  const ip = clientIp(req)
  if (!ipOmit(ip)) headers["x-real-ip"] = ip
  for (const h of ["x-opencode-request", "x-opencode-client", "x-opencode-project"]) {
    const v = req.headers[h]
    if (typeof v === "string" && v) headers[h] = v
  }
  return headers
}

function bearer(req) {
  const v = req.headers["authorization"]
  return typeof v === "string" && v.startsWith("Bearer ") ? v.slice(7).trim() : ""
}

function authForUpstream(req) {
  const incoming = bearer(req)
  if (config.proxyKey) {
    if (incoming !== config.proxyKey) return null
    const zen = req.headers["x-zen-key"]
    if (typeof zen === "string" && zen && zen !== "public") return `Bearer ${zen}`
    if (config.defaultZenKey) return `Bearer ${config.defaultZenKey}`
    return "Bearer public"
  }
  if (incoming && incoming !== "public") return `Bearer ${incoming}`
  if (config.defaultZenKey) return `Bearer ${config.defaultZenKey}`
  return "Bearer public"
}

// The configured ceiling wins when it is a positive number; 0/absent keeps the
// shipped default (see MAX_BODY).
function maxBodyBytes() {
  const n = Number(config.maxBodyBytes)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : MAX_BODY
}

async function readBody(req, limit = maxBodyBytes()) {
  let raw = ""
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > limit) {
      const err = new Error("request body too large")
      err.statusCode = 413
      throw err
    }
  }
  return raw
}

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(data))
}

// ---- Anthropic Messages API layer ------------------------------------------
// zen-proxy also speaks the Anthropic Messages protocol (`POST /v1/messages`)
// so Claude Code can point straight at it. Requests are translated to whichever
// endpoint family the target model actually lives on, and the reply is
// translated back. See AGENT_PREAMBLE_TEXT above for why an opencode preamble is
// prepended to the client's system prompt.


// Anthropic clients authenticate with `x-api-key`; the OpenAI-compatible SDKs
// use `Authorization: Bearer`. Accept either so Claude Code and curl both work.
function bearerOrKey(req) {
  const v = req.headers["authorization"]
  if (typeof v === "string" && v.startsWith("Bearer ")) return v.slice(7).trim()
  const k = req.headers["x-api-key"]
  if (typeof k === "string" && k.trim()) return k.trim()
  return ""
}

async function handleMessages(req, res) {
  const start = Date.now()
  let body
  try {
    body = JSON.parse(await readBody(req))
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      const e = anthropicError(400, { error: { type: "invalid_request_error", message: "body must be a JSON object" } })
      return json(res, e.status, e.body)
    }
  } catch (err) {
    const e = anthropicError(err?.statusCode === 413 ? 413 : 400, {
      error: { type: err?.statusCode === 413 ? "request_too_large" : "invalid_request_error", message: err?.message ?? "invalid JSON body" },
    })
    return json(res, e.status, e.body)
  }

  const { requested, candidates } = resolveModel(body.model)
  const isStream = !!body.stream
  // Route the credential the client sent. x-api-key is Anthropic's convention
  // and may legitimately be a real Zen key, so prefer it over the bearer token.
  const apiKey = bearerOrKey(req)
  let auth = authForUpstream(req)
  if (typeof req.headers["x-api-key"] === "string" && req.headers["x-api-key"].trim()) {
    auth = `Bearer ${req.headers["x-api-key"].trim()}`
  } else if (apiKey && apiKey !== "public" && !config.proxyKey && !config.defaultZenKey) {
    auth = `Bearer ${apiKey}`
  }
  if (!auth) {
    recordReq(req, requested, Date.now() - start, 401)
    const e = anthropicError(401, { error: { type: "authentication_error", message: "invalid proxy key" } })
    return json(res, e.status, e.body)
  }
  // An Anthropic client always sends some token (Claude Code uses whatever
  // ANTHROPIC_AUTH_TOKEN holds, which for a local proxy is usually a placeholder).
  // If upstream rejects it, fall back to the configured key or the anonymous tier
  // rather than failing the request outright.
  const fallbackAuth = config.proxyKey ? null : config.defaultZenKey ? `Bearer ${config.defaultZenKey}` : "Bearer public"
  let triedFallback = false

  let lastErr = null
  let lastStatus = 502
  let firstErr = null
  let firstStatus = 0
  let used = requested
  // The model the client chose is tried first; transient failures are retried
  // against that same model before the chain moves on.
  const retries = config.retriesPerModel > 0 ? Math.floor(config.retriesPerModel) : 0
  // Same bridge rule as the chat path: a caller that sends no tools (title-gen
  // helper calls, plain API use) gets opencode's whole manifest pinned off, or
  // the gate answers 403 for every model and the request walks the chain.
  const bridge = (body?.tools ?? []).length ? [] : gateBridgeTools()
  const bridged = bridge.length > 0
  for (const model of candidates) {
    const chosen = model === candidates[0]
    used = model
    const format = modelFormat(model)
    // Upstream only ever sees streams (see collectChatCompletion); whether the
    // client asked for one decides how the reply is shaped, not what is sent.
    const payload = format === "responses" ? responsesRequest(anthropicToChatBody(body, model), model, true) : { ...anthropicToChatBody(body, model), stream: true }
    if (bridged) {
      payload.tools = format === "responses" ? chatToolsToResponses(bridge) : bridge
      // /responses takes only "auto"; the chat endpoint takes the pin.
      if (format === "responses") delete payload.tool_choice
      else payload.tool_choice = "none"
    }
    let delayMs = 0
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      delayMs = 0
      let upstreamRes
      try {
        upstreamRes = await upstreamFetch(`${config.upstream}${format === "responses" ? "/responses" : "/chat/completions"}`, {
          method: "POST",
          headers: zenHeaders(req, auth),
          body: JSON.stringify(payload),
          // Not req.signal: Node 24 aborts it as soon as the request body is read,
          // which killed every streamed request. Node 18-22 have none, so streams
          // never carried a signal there either.
          signal: isStream ? undefined : AbortSignal.timeout(config.timeoutMs),
        }, { req })
      } catch (err) {
        // Walking the rest of the chain cannot help when no proxy is usable.
        if (err?.code === "NO_PROXY") {
          recordReq(req, requested, Date.now() - start, 503)
          return json(res, 503, anthropicError(503, { error: { type: "api_error", message: err.message } }).body)
        }
        lastErr = { error: { type: "api_error", message: err.message } }
        lastStatus = 502
        if (attempt < retries) {
          delayMs = config.retryBackoffMs * (attempt + 1)
          continue
        }
        recordObserved(model, false)
        break
      }

      if (upstreamRes.status === 401 && !triedFallback && fallbackAuth && fallbackAuth !== auth) {
        triedFallback = true
        auth = fallbackAuth
        attempt--
        continue
      }

      if (upstreamRes.ok) {
        if (isStream) {
          const chunks = format === "responses" ? responsesChunksAsChat(upstreamRes) : sseChunks(upstreamRes)
          relayAnthropicStream(req, res, chunks, requested, model, bridged)
          res.on("finish", () => {
            recordReq(req, `${requested}→${model}`, Date.now() - start, 200)
            recordObserved(model, true)
          })
          return
        }
        try {
          const content = format === "responses" ? await collectResponses(upstreamRes) : await collectChatCompletion(upstreamRes)
          const shaped = stripToolCalls(format === "responses" ? responsesToChat(content, requested, model) : content, bridged)
          recordReq(req, `${requested}→${model}`, Date.now() - start, 200)
          recordObserved(model, true)
          if (model !== requested) {
            res.setHeader?.("x-zen-served-by", model)
            res.setHeader?.("x-zen-fallback", "true")
          }
          return json(res, 200, chatToAnthropic(shaped, requested, model))
        } catch {
          recordReq(req, requested, Date.now() - start, 502)
          return json(res, 502, anthropicError(502, { error: { type: "api_error", message: "bad upstream response" } }).body)
        }
      }

      try {
        lastErr = await upstreamRes.json()
      } catch {
        lastErr = { error: { type: "api_error", message: `upstream returned ${upstreamRes.status}` } }
      }
      lastStatus = upstreamRes.status
      const retryAfterMs = Math.min(parseRetryAfter(upstreamRes.headers.get("retry-after")) * 1000, 3000)
      if (transientUpstream(upstreamRes.status, lastErr) && attempt < retries) {
        delayMs = Math.max(config.retryBackoffMs * (attempt + 1), retryAfterMs)
        continue
      }
      recordObserved(model, false)
      if (retryableUpstream(upstreamRes.status, lastErr)) {
        if (retryAfterMs > 0) await new Promise((r) => setTimeout(r, retryAfterMs))
        break
      }
      // A deterministic client-visible error (bad request, auth, …): report it
      // as-is rather than masking it with the rest of the chain.
      recordReq(req, `${requested}→${used}`, Date.now() - start, lastStatus)
      const e = anthropicError(lastStatus, lastErr)
      res.writeHead(e.status, { "content-type": "application/json" })
      res.end(JSON.stringify(e.body))
      return
    }
    if (chosen && firstErr == null) {
      firstErr = lastErr
      firstStatus = lastStatus
    }
  }

  // Every candidate failed. Surface the error from the model the client asked
  // for — the tail of the chain is an implementation detail and used to leak
  // unrelated failures (e.g. a retired model's 410 "deprecated").
  const finalErr = firstErr ?? lastErr
  const finalStatus = firstErr ? firstStatus : lastStatus
  recordReq(req, requested, Date.now() - start, finalStatus)
  const e = anthropicError(finalStatus, finalErr ?? { error: { type: "api_error", message: "all free models are unavailable" } })
  res.writeHead(e.status, { "content-type": "application/json" })
  res.end(JSON.stringify(e.body))
}

async function handleChat(req, res) {
  const start = Date.now()
  let body
  try {
    const raw = await readBody(req)
    body = JSON.parse(raw)
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json(res, 400, { error: { type: "invalid_request_error", message: "body must be a JSON object" } })
    }
  } catch (err) {
    if (err && err.statusCode === 413) {
      return json(res, 413, { error: { type: "invalid_request_error", message: "request body too large" } })
    }
    return json(res, 400, { error: { type: "invalid_request_error", message: "invalid JSON body" } })
  }

  const { requested, candidates } = resolveModel(body.model)
  const isStream = !!body.stream
  const auth = authForUpstream(req)
  if (!auth) {
    recordReq(req, requested, Date.now() - start, 401)
    return json(res, 401, { error: { type: "invalid_request_error", message: "invalid proxy key" } })
  }

  let lastErr = null
  let lastStatus = 502
  let firstErr = null
  let firstStatus = 0
  let used = requested
  // The model the client chose is tried first; transient failures are retried
  // against that same model before the chain moves on.
  const retries = config.retriesPerModel > 0 ? Math.floor(config.retriesPerModel) : 0
  const bridge = body.tools?.length ? [] : gateBridgeTools()
  const bridged = bridge.length > 0
  for (const model of candidates) {
    const chosen = model === candidates[0]
    used = model
    const format = modelFormat(model)
    // Streams upstream regardless of what the client asked for — see
    // collectChatCompletion — and the collector puts the shape back.
    const payload =
      format === "responses" ? responsesRequest(body, model, true) : { ...body, model, stream: true }
    if (bridged) {
      payload.tools = format === "responses" ? chatToolsToResponses(bridge) : bridge
      // The gateway takes only "auto" on /responses, so forwarding anything the
      // caller sent there is a hard error rather than a hint.
      if (format === "responses") delete payload.tool_choice
      else payload.tool_choice = "none"
    }
    let delayMs = 0
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      delayMs = 0
      let upstreamRes
      try {
        upstreamRes = await upstreamFetch(`${config.upstream}${format === "responses" ? "/responses" : "/chat/completions"}`, {
          method: "POST",
          headers: zenHeaders(req, auth),
          body: JSON.stringify(payload),
          // Not req.signal: Node 24 aborts it as soon as the request body is read,
          // which killed every streamed request. Node 18-22 have none, so streams
          // never carried a signal there either.
          signal: isStream ? undefined : AbortSignal.timeout(config.timeoutMs),
        }, { req })
      } catch (err) {
        if (err?.code === "NO_PROXY") {
          recordReq(req, requested, Date.now() - start, 503)
          return json(res, 503, { error: { type: "upstream_error", message: err.message } })
        }
        lastErr = { error: { type: "upstream_error", message: err.message } }
        lastStatus = 502
        if (attempt < retries) {
          delayMs = config.retryBackoffMs * (attempt + 1)
          continue
        }
        recordObserved(model, false)
        break
      }

      if (upstreamRes.ok) {
        if (isStream) {
          if (model !== requested) {
            res.setHeader?.("x-zen-served-by", model)
            res.setHeader?.("x-zen-fallback", "true")
          }
          if (format === "responses") {
            relayResponsesStream(req, res, upstreamRes, requested, bridged)
          } else {
            relayStream(req, res, upstreamRes, requested, bridged)
          }
          res.on("finish", () => { recordReq(req, `${requested}→${model}`, Date.now() - start, 200); recordObserved(model, true) })
          return
        }
        try {
          const content = format === "responses" ? await collectResponses(upstreamRes) : await collectChatCompletion(upstreamRes)
          if (format === "responses") {
            recordReq(req, `${requested}→${model}`, Date.now() - start, 200)
            recordObserved(model, true)
            if (model !== requested) {
              res.setHeader?.("x-zen-served-by", model)
              res.setHeader?.("x-zen-fallback", "true")
            }
            return json(res, 200, stripToolCalls(responsesToChat(content, requested, model), bridged))
          }
          if (model !== requested) {
            // Make the fallback visible to any client, not just JSON readers.
            res.setHeader?.("x-zen-served-by", model)
            res.setHeader?.("x-zen-fallback", "true")
          }
          if (content && typeof content === "object") {
            content.model = requested
            if (model !== requested) content.zen_served_by = model
            stripToolCalls(content, bridged)
          }
          recordReq(req, `${requested}→${model}`, Date.now() - start, 200)
          recordObserved(model, true)
          return json(res, 200, content)
        } catch {
          recordReq(req, requested, Date.now() - start, 502)
          return json(res, 502, { error: { type: "upstream_error", message: "bad upstream response" } })
        }
      }

      try {
        lastErr = await upstreamRes.json()
      } catch {
        lastErr = { error: { type: "upstream_error", message: `upstream returned ${upstreamRes.status}` } }
      }
      lastStatus = upstreamRes.status
      const retryAfterMs = Math.min(parseRetryAfter(upstreamRes.headers.get("retry-after")) * 1000, 3000)
      if (transientUpstream(upstreamRes.status, lastErr) && attempt < retries) {
        delayMs = Math.max(config.retryBackoffMs * (attempt + 1), retryAfterMs)
        continue
      }
      // Try the next candidate not only on 429/5xx but also when the upstream
      // reports a model/environment-level failure (e.g. a provider that is
      // temporarily "unavailable", a geo-blocked free model, or a stale model
      // id) so one dead model doesn't brick the whole request.
      recordObserved(model, false)
      if (retryableUpstream(upstreamRes.status, lastErr)) {
        if (retryAfterMs > 0) await new Promise((r) => setTimeout(r, retryAfterMs))
        break
      }
      // A deterministic client-visible error (bad request, auth, …): report it
      // as-is rather than masking it with the rest of the chain.
      recordReq(req, `${requested}→${used}`, Date.now() - start, lastStatus)
      res.writeHead(lastStatus, { "content-type": "application/json" })
      res.end(JSON.stringify(lastErr))
      return
    }
    if (chosen && firstErr == null) {
      firstErr = lastErr
      firstStatus = lastStatus
    }
  }

  // Every candidate failed. Surface the error from the model the client asked
  // for — the tail of the chain is an implementation detail and used to leak
  // unrelated failures (e.g. a retired model's 410 "deprecated").
  const finalStatus = firstErr ? firstStatus : lastStatus
  const finalErr = firstErr ?? lastErr
  // Nothing served this request, so the feed names no server — the last model
  // tried is an implementation detail and used to read as "another model
  // answered" while the error shown actually came from the requested one.
  recordReq(req, requested, Date.now() - start, finalStatus)
  res.writeHead(finalStatus, { "content-type": "application/json" })
  res.end(
    JSON.stringify(finalErr ?? { error: { type: "free_usage_limit_error", message: "all free models are rate-limited" } }),
  )
}

// Turns a Response body into an async iterable of raw SSE text blocks, so the
// Anthropic relay can read chat and Responses streams through one code path.
async function* sseChunks(upstreamRes) {
  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf("\n\n")) !== -1) {
        yield buf.slice(0, i + 2)
        buf = buf.slice(i + 2)
      }
    }
    if (buf.trim()) yield buf
  } finally {
    try {
      reader.cancel()
    } catch {}
  }
}

// The free-tier gate only answers streaming traffic: a non-streaming request is
// refused with 403 FreeTierError for every model, no matter which one is asked.
// That used to walk the whole fallback chain (~5s), mark every model as failed
// on the dashboard and return a 403 that read like a different model had been
// used. So a non-streaming client request is sent upstream as a stream and the
// SSE is re-assembled into the plain JSON the client asked for.
async function collectChatCompletion(upstreamRes) {
  if (!/text\/event-stream/i.test(upstreamRes.headers.get("content-type") ?? "")) return upstreamRes.json()
  const message = { role: "assistant", content: "" }
  const out = {
    id: `chatcmpl-${randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "",
    choices: [{ index: 0, message, finish_reason: "stop" }],
  }
  const toolCalls = []
  for await (const block of sseChunks(upstreamRes)) {
    let raw = ""
    for (const line of block.split("\n")) if (line.startsWith("data:")) raw = line.slice(5).trim()
    if (!raw || raw === "[DONE]") continue
    let d
    try {
      d = JSON.parse(raw)
    } catch {
      continue
    }
    if (d?.error) throw new Error(d.error.message ?? "upstream stream error")
    if (d?.id) out.id = d.id
    if (d?.model) out.model = d.model
    if (d?.created) out.created = d.created
    if (d?.usage) out.usage = d.usage
    const choice = d?.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (typeof delta.content === "string" && delta.content) message.content += delta.content
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content)
      message.reasoning_content = (message.reasoning_content ?? "") + delta.reasoning_content
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0
      const cur = toolCalls[idx] ?? (toolCalls[idx] = { id: tc.id ?? `call_${idx}`, type: "function", function: { name: "", arguments: "" } })
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.function.name = tc.function.name
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments
    }
    if (choice.finish_reason) out.choices[0].finish_reason = choice.finish_reason
  }
  const calls = toolCalls.filter(Boolean)
  if (calls.length) {
    message.tool_calls = calls
    if (out.choices[0].finish_reason === "stop") out.choices[0].finish_reason = "tool_calls"
  }
  return out
}

// Same idea for /responses: the finished response object arrives whole in the
// `response.completed` event, which is exactly what responsesToChat expects.
async function collectResponses(upstreamRes) {
  if (!/text\/event-stream/i.test(upstreamRes.headers.get("content-type") ?? "")) return upstreamRes.json()
  let result = null
  for await (const block of sseChunks(upstreamRes)) {
    let raw = ""
    for (const line of block.split("\n")) if (line.startsWith("data:")) raw = line.slice(5).trim()
    if (!raw || raw === "[DONE]") continue
    let d
    try {
      d = JSON.parse(raw)
    } catch {
      continue
    }
    if (d?.error) throw new Error(d.error.message ?? "upstream stream error")
    if (d?.type === "response.completed" || d?.type === "response.incomplete") result = d.response ?? result
    else if (d?.response?.output) result = d.response
  }
  if (!result) throw new Error("stream ended without a completed response")
  return result
}

// Responses SSE -> chat-shaped SSE text blocks, so the Anthropic translator
// only ever has to understand one wire format.
async function* responsesChunksAsChat(upstreamRes) {
  const tools = []
  for await (const block of sseChunks(upstreamRes)) {
    let raw = ""
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) raw = line.slice(5).trim()
    }
    if (!raw || raw === "[DONE]") continue
    let d
    try {
      d = JSON.parse(raw)
    } catch {
      continue
    }
    if (!d || typeof d !== "object") continue
    const out = { id: "chatcmpl-stream", object: "chat.completion.chunk", model: "", choices: [{ index: 0, delta: {} }] }
    let emit = false
    if (d.type === "response.output_text.delta" && d.delta) {
      out.choices[0].delta.content = d.delta
      emit = true
    } else if ((d.type === "response.reasoning_text.delta" || d.type === "response.reasoning_summary_text.delta") && d.delta) {
      out.choices[0].delta.reasoning_content = d.delta
      emit = true
    } else if (d.type === "response.output_item.added" && d.item?.type === "function_call") {
      tools.push({ id: d.item.call_id ?? d.item.id ?? "call_0" })
      out.choices[0].delta.tool_calls = [{ index: tools.length - 1, id: d.item.call_id ?? d.item.id ?? "call_0", type: "function", function: { name: d.item.name ?? "unknown", arguments: "" } }]
      emit = true
    } else if (d.type === "response.function_call_arguments.delta" && d.delta) {
      out.choices[0].delta.tool_calls = [{ index: 0, function: { arguments: d.delta } }]
      emit = true
    } else if (d.type === "response.completed" || d.type === "response.incomplete") {
      out.choices[0].finish_reason = d.type === "response.incomplete" ? "length" : tools.length ? "tool_calls" : "stop"
      emit = true
    }
    if (d.response?.usage) out.usage = usageToChat(d.response.usage)
    if (emit) yield `data: ${JSON.stringify(out)}\n\n`
  }
}

// chat.completions SSE -> Anthropic Messages SSE. Anthropic's stream is a fixed
// envelope: message_start, then one content_block_start/delta/stop per block,
// then message_delta carrying stop_reason and usage, then message_stop. Tool
// arguments arrive as input_json_delta, so they are buffered until the block ends
// rather than being re-parsed per chunk.
function relayAnthropicStream(req, res, chunks, requested, servedBy, strip = false) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // Streaming responses get no JSON body a client could inspect, so the
    // serving model is exposed as headers instead.
    ...(servedBy && servedBy !== requested ? { "x-zen-served-by": servedBy, "x-zen-fallback": "true" } : {}),
  })
  const id = `msg_${randomBytes(12).toString("hex")}`
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)

  const st = { textOpen: false, thinkOpen: false, toolIndex: 0, blocks: new Map(), finish: "stop", usage: null }
  emit("message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model: requested,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  const closeText = () => {
    if (st.textOpen) {
      emit("content_block_stop", { index: 0 })
      st.textOpen = false
    }
  }
  const closeThink = () => {
    if (st.thinkOpen) {
      emit("content_block_stop", { index: 0 })
      st.thinkOpen = false
    }
  }

  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (req.signal?.addEventListener) req.signal.addEventListener("abort", onAbort)
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs)
  const cleanup = () => {
    clearTimeout(timer)
    if (req.signal?.removeEventListener) req.signal.removeEventListener("abort", onAbort)
  }

  const pump = async () => {
    try {
      for await (const chunkText of chunks) {
        {
          for (const line of chunkText.split("\n")) {
            if (!line.startsWith("data:")) continue
            const raw = line.slice(5).trim()
            if (!raw || raw === "[DONE]") continue
            let d
            try {
              d = JSON.parse(raw)
            } catch {
              continue
            }
            if (!d || typeof d !== "object") continue
            if (d.usage) st.usage = d.usage
            const choice = d.choices?.[0]
            const delta = choice?.delta ?? {}
            // The bridge tools exist only to satisfy the gate; a caller that
            // offered none must never see a call to one (see stripToolCalls).
            if (choice?.finish_reason) st.finish = strip && choice.finish_reason === "tool_calls" ? "stop" : choice.finish_reason
            if (typeof delta.content === "string" && delta.content) {
              closeThink()
              if (!st.textOpen) {
                emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
                st.textOpen = true
              }
              emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: delta.content } })
            }
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
              if (!st.textOpen && !st.thinkOpen) {
                emit("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } })
                st.thinkOpen = true
              }
              emit("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: delta.reasoning_content } })
            }
            for (const tc of strip ? [] : delta.tool_calls ?? []) {
              closeThink()
              closeText()
              const tIndex = tc.index ?? 0
              if (!st.blocks.has(tIndex)) {
                const rawName = tc.function?.name ?? "unknown"
                const mapped = remapAgentTool(rawName, "{}")
                st.blocks.set(tIndex, {
                  index: tIndex + 1,
                  id: tc.id ?? `toolu_${randomBytes(8).toString("hex")}`,
                  raw: rawName,
                  name: mapped ? mapped.name : rawName,
                  args: "",
                })
                emit("content_block_start", {
                  index: tIndex + 1,
                  content_block: { type: "tool_use", id: st.blocks.get(tIndex).id, name: st.blocks.get(tIndex).name, input: {} },
                })
              }
              if (tc.function?.arguments) st.blocks.get(tIndex).args += tc.function.arguments
            }
          }
        }
      }
      closeThink()
      closeText()
      for (const t of st.blocks.values()) {
        // Rename the caller's argument keys here too — streamed arguments are
        // accumulated and only emitted at the end of the block.
        const mapped = remapAgentTool(t.raw, t.args || "{}")
        const json = mapped ? mapped.args : t.args || "{}"
        emit("content_block_delta", { index: t.index, delta: { type: "input_json_delta", partial_json: json } })
        emit("content_block_stop", { index: t.index })
      }
      const u = st.usage ?? {}
      emit("message_delta", {
        delta: { stop_reason: STOP_REASON[st.finish] ?? "end_turn", stop_sequence: null },
        usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 },
      })
      emit("message_stop", {})
      res.write("data: [DONE]\n\n")
      res.end()
    } catch {
      res.end()
    } finally {
      cleanup()
    }
  }
  return pump()
}

// A caller that sent no tools cannot run one, and the gateway hands them back
// anyway — it ignores tool_choice "none" and answers a plain summarization
// prompt with real read calls, which pi treats as a hard failure. So drop them
// from the reply, and never claim a tool call in finish_reason.
function stripToolCalls(chunk, strip) {
  if (!strip) return chunk
  for (const choice of chunk?.choices ?? []) {
    const body = choice?.delta ?? choice?.message
    if (body?.tool_calls) delete body.tool_calls
    if (choice?.finish_reason === "tool_calls") choice.finish_reason = "stop"
  }
  return chunk
}

function relayStream(req, res, upstreamRes, requested, strip = false) {
  res.writeHead(200, {
    "content-type": upstreamRes.headers.get("content-type") ?? "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (req.signal?.addEventListener) req.signal.addEventListener("abort", onAbort)
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs)
  ctrl.signal.addEventListener("abort", () => {
    reader.cancel().catch(() => {})
  })
  const cleanup = () => {
    clearTimeout(timer)
    if (req.signal?.removeEventListener) req.signal.removeEventListener("abort", onAbort)
  }
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          if (buffer.trim()) res.write(buffer)
          res.end()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const out = rewriteSSE(block, requested, strip)
          if (out) res.write(out)
        }
      }
    } catch {
      res.end()
    } finally {
      cleanup()
    }
  }
  return pump()
}

// Build a Responses API request from a chat.completions body.
function responsesRequest(body, model, isStream) {
  const payload = { model, input: chatMessagesToInput(body.messages), stream: !!isStream }
  if (body.temperature != null) payload.temperature = body.temperature
  if (body.top_p != null) payload.top_p = body.top_p
  if (body.parallel_tool_calls != null) payload.parallel_tool_calls = body.parallel_tool_calls
  const tools = chatToolsToResponses(body.tools)
  if (tools) payload.tools = tools
  if (body.tool_choice != null) {
    const tc = body.tool_choice
    payload.tool_choice = typeof tc === "string" ? tc : { type: "function", name: tc?.function?.name ?? tc?.name }
  }
  // Reasoning-first models (muse-spark, gpt-5/6) burn hundreds of tokens on
  // reasoning before emitting text, so a tiny cap yields an empty completion.
  // Only forward a budget the caller actually asked for.
  const mt = body.max_completion_tokens ?? body.max_tokens
  if (mt != null && Number.isFinite(Number(mt)) && Number(mt) > 0) payload.max_output_tokens = Number(mt)
  return payload
}

// Credentials used by the auto-sync health probe. Lets a user probe the
// anonymous free tier (public) even while BYOK is configured, or require the
// key so probes reflect their own quota.
function probeAuthHeader() {
  const mode = String(config.probeAuth ?? "auto").toLowerCase()
  if (mode === "anonymous") return "Bearer public"
  if (config.defaultZenKey) return `Bearer ${config.defaultZenKey}`
  if (mode === "key") return "Bearer public" // no key configured; anonymous is all we can do
  return "Bearer public"
}

// Health probes have to look like agent traffic or the free-tier gate refuses
// them with FreeTierError before a model is ever reached: opencode's own tool
// manifest plus `stream: true` is what a real client sends, so the probe sends
// exactly that. Without it every model used to land in the "gate-blocked"
// bucket, which told the user nothing about whether it actually works.
function agentProbePayload(id, format) {
  const tools = gateBridgeTools()
  if (format === "responses") {
    const payload = { model: id, input: "ping", max_output_tokens: 32, stream: true }
    const converted = chatToolsToResponses(tools)
    if (converted) payload.tools = converted
    return payload
  }
  const payload = { model: id, messages: [{ role: "user", content: "ping" }], max_tokens: 5, stream: true }
  if (tools.length) {
    payload.tools = tools
    // The bridge is for the gate, not the answer: a "ping" should come back as
    // text, never as a tool call.
    payload.tool_choice = "none"
  }
  return payload
}

// One-shot liveness probe for a model, using the endpoint family that model
// actually lives on. Returns the raw Response so sync can classify it.
async function probeModel(id, auth, session) {
  const format = modelFormat(id)
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: auth,
    "user-agent": config.ua,
  }
  if (session) for (const h of SESSION_HEADERS) headers[h] = session
  const r = await upstreamFetch(`${config.upstream}${format === "responses" ? "/responses" : "/chat/completions"}`, {
    method: "POST",
    headers,
    body: JSON.stringify(agentProbePayload(id, format)),
    signal: AbortSignal.timeout(Math.min(config.timeoutMs, 30_000)),
  }, { health: true })
  // A live model answers the streamed probe with SSE, and sync only needs the
  // status. Hang up instead of waiting for the model to finish its "ping".
  if (r.ok) {
    try { await r.body?.cancel() } catch {}
  }
  return r
}

// Stream a Responses SSE body back as chat.completion.chunk SSE.
function relayResponsesStream(req, res, upstreamRes, requested, strip = false) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const id = `chatcmpl-${randomBytes(12).toString("hex")}`
  const created = Math.floor(Date.now() / 1000)
  const base = { id, object: "chat.completion.chunk", created, model: requested }
  const state = { tools: [], usage: null, finish: "stop" }
  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (req.signal?.addEventListener) req.signal.addEventListener("abort", onAbort)
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs)
  ctrl.signal.addEventListener("abort", () => {
    reader.cancel().catch(() => {})
  })
  const cleanup = () => {
    clearTimeout(timer)
    if (req.signal?.removeEventListener) req.signal.removeEventListener("abort", onAbort)
  }
  const send = (choices, extra) =>
    res.write(`data: ${JSON.stringify({ ...base, choices, ...(extra ?? {}) })}\n\n`)

  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (!block.trim()) continue
          let event = ""
          let raw = ""
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim()
            else if (line.startsWith("data:")) raw = line.slice(5).trim()
          }
          if (!raw || raw === "[DONE]") continue
          let data
          try {
            data = JSON.parse(raw)
          } catch {
            continue
          }
          if (data?.response?.usage) state.usage = data.response.usage
          if (data?.type === "response.completed" || data?.type === "response.incomplete") {
            state.finish = data.type === "response.incomplete" ? "length" : state.tools.length ? "tool_calls" : "stop"
            continue
          }
          if (data?.type === "error" || data?.error) continue
          for (const delta of responsesEventToDeltas(event, data, state)) {
            if (strip && delta.tool_calls) delete delta.tool_calls
            if (Object.keys(delta).length === 0) continue
            send([{ index: 0, delta, finish_reason: null }])
          }
        }
      }
      send([{ index: 0, delta: {}, finish_reason: strip ? "stop" : state.finish }], state.usage ? { usage: usageToChat(state.usage) } : {})
      res.write("data: [DONE]\n\n")
      res.end()
    } catch {
      res.end()
    } finally {
      cleanup()
    }
  }
  return pump()
}

function rewriteSSE(block, requested, strip = false) {
  if (!block.trim()) return null
  const lines = block.split("\n")
  const out = []
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const payload = line.slice(6)
      if (payload === "[DONE]") {
        out.push(line)
        continue
      }
      try {
        const parsed = JSON.parse(payload)
        if (parsed && typeof parsed === "object" && "model" in parsed) parsed.model = requested
        stripToolCalls(parsed, strip)
        out.push(`data: ${JSON.stringify(parsed)}`)
      } catch {
        out.push(line)
      }
    } else {
      out.push(line)
    }
  }
  return out.join("\n") + "\n\n"
}

let modelsCache = { at: 0, data: [], ok: false }
let modelsFetching = null
async function fetchModels() {
  if (modelsCache.at && Date.now() - modelsCache.at < config.cacheMs) return modelsCache
  if (modelsFetching) return modelsFetching
  modelsFetching = (async () => {
    try {
      const res = await upstreamFetch(`${config.upstream}/models`, {
        headers: { "user-agent": config.ua },
        signal: AbortSignal.timeout(15_000),
      }, { health: true })
      if (res.ok) {
        const parsed = await res.json()
        const upstreamModels = parsed.data ?? []
        const allowed = ALLOWED()
        const dead = new Set(syncState.dead)
        let free
        if (syncState.ok && syncState.at) {
          const live = new Set([...syncState.working, ...syncState.rateLimited])
          free = upstreamModels.filter((m) => (live.has(m.id) || allowed.has(m.id)) && !dead.has(m.id))
        } else {
          free = upstreamModels.filter((m) => (m.id.endsWith("-free") || allowed.has(m.id)) && !dead.has(m.id))
        }
        modelsCache = { at: Date.now(), data: free, ok: true }
      } else {
        modelsCache = { at: Date.now(), data: modelsCache.data, ok: false }
      }
    } catch {
      modelsCache = { at: Date.now(), data: modelsCache.data, ok: false }
    }
    return modelsCache
  })()
  try {
    return await modelsFetching
  } finally {
    modelsFetching = null
  }
}

async function syncModels() {
  if (syncState.running) return syncState
  syncState.running = true
  syncState.at = Date.now()
  const start = Date.now()
  try {
    const res = await upstreamFetch(`${config.upstream}/models`, {
      headers: { "user-agent": config.ua },
      signal: AbortSignal.timeout(15_000),
    }, { health: true })
    if (!res.ok) throw new Error(`upstream /models → ${res.status}`)
    const parsed = await res.json()
    const upstreamIds = new Set((parsed.data ?? []).map((m) => m.id))
    const isFree = (id) => VALID_MODEL_ID.test(id) && !NOT_CHAT_SERVABLE.some((re) => re.test(id))
    const current = [...config.fallbackModels].filter(isFree)
    // Everything the upstream currently offers for free. The user's list is
    // merged with this, so a model that exists but is temporarily blocked still
    // gets (re)added — the list self-heals instead of staying shrunken.
    const discovered = [...upstreamIds].filter((id) => id.endsWith("-free") && isFree(id))
    const candidates = [...new Set([...current, ...discovered])]
    const working = []
    const rateLimited = []
    const dead = []
    const flaky = []
    const gated = []
    // Only definitively-gone models are dropped from the user's list; `flaky`
    // ones stay configured so they recover on their own.
    const removeFromCurrent = new Set()
    const auth = probeAuthHeader()
    let idx = 0
    const probe = async () => {
      while (idx < candidates.length) {
        const id = candidates[idx++]
        try {
          const r = await probeModel(id, auth, sessionHeader())
          let bodyErr = ""
          try {
            const j = await r.json()
            if (j && (j.error || j.type === "error")) {
              const e = j.error ?? j
              bodyErr = (e.type || "") + " " + (e.message || "")
            }
          } catch {}
          if (r.ok && !bodyErr) { working.push(id); modelHealth.set(id, 0) }
          else if (r.status === 429 && !bodyErr) { rateLimited.push(id); modelHealth.set(id, 0) }
          else {
            // Only drop a model from the user's config on definitive proof that it
            // is gone: "not supported", 404, 410 Gone, "no such model", "has been
            // deprecated". Everything else (403 FreeTierError, 429, timeouts, 5xx)
            // is a *temporary* access or capacity condition — the model comes back
            // on its own, so deleting it would silently shrink the user's list and
            // lose it forever.
            const gone =
              r.status === 404 ||
              r.status === 410 ||
              /model_not_found|no such model|does not exist|is not supported|not supported|has been deprecated|no longer available/i.test(bodyErr)
            // Key/auth problems are not model problems either.
            const authErr = /AuthError|invalid api key|missing api key/i.test(bodyErr)
            // 403 FreeTierError even though the probe was agent-shaped (tools +
            // stream, see agentProbePayload). The gate refused the exact shape
            // a real client sends — likely a session/trust condition the probe
            // can't satisfy, so it says nothing about the model's health. Never
            // call it flaky, never remove it.
            const isGated = /FreeTierError|free tier can only/i.test(bodyErr)
            // Temporary blocks: keep the model, just remember it is unhealthy.
            const temporary = /RegionError|not available in your country|rate.?limit|overloaded/i.test(bodyErr)
            if (gone) { dead.push(id); removeFromCurrent.add(id) }
            else if (isGated) { gated.push(id) }
            else if (authErr) { flaky.push(id) }
            else {
              if (temporary) {
                modelHealth.set(id, 0)
                flaky.push(id)
              } else {
                const fails = (modelHealth.get(id) ?? 0) + 1
                modelHealth.set(id, fails)
                if (fails >= 3) { dead.push(id); removeFromCurrent.add(id) }
                else flaky.push(id)
              }
            }
          }
        } catch {
          const fails = (modelHealth.get(id) ?? 0) + 1
          modelHealth.set(id, fails)
          if (fails >= 3) dead.push(id)
          else flaky.push(id)
        }
      }
    }
    await Promise.all([probe(), probe(), probe()])
    // Keep the user's order, drop only definitively-gone models, then append
    // anything upstream offers that the user doesn't have yet. Temporary blocks
    // never remove a model, and new models appear without any manual step.
    const newList = current.filter((id) => !removeFromCurrent.has(id))
    // Only auto-add newly discovered models that are actually reachable (ok,
    // rate-limited or free-tier-gated). A model that errors on its first probe
    // is retired upstream and shouldn't be pushed at the user.
    for (const id of discovered) {
      if (!newList.includes(id) && !removeFromCurrent.has(id) && !flaky.includes(id)) newList.push(id)
    }
    for (const id of working) if (!newList.includes(id)) newList.push(id)
    const changed = newList.join(",") !== current.join(",")
    if (changed && newList.length) {
      config.fallbackModels = newList
      // Only a user-owned list is written back. If the list is still following
      // models.json, persisting it here would pin this install to today's
      // catalog and it would never see the next bot refresh.
      if (fallbackModelsPinned) {
        try { saveConfig({ fallbackModels: newList }) } catch {}
      }
      log(`auto-sync: updated model list (${working.length} ok, ${rateLimited.length} rate-limited, ${gated.length} gate-blocked, ${flaky.length} flaky, ${dead.length} dead${fallbackModelsPinned ? "" : ", not pinned"})`)
    } else {
      log(`auto-sync: list unchanged (${working.length} ok, ${rateLimited.length} rate-limited, ${gated.length} gate-blocked, ${flaky.length} flaky, ${dead.length} dead)`)
    }
    syncState.working = working
    syncState.rateLimited = rateLimited
    syncState.flaky = flaky
    syncState.gated = gated
    syncState.dead = dead
    syncState.error = ""
    syncState.ok = true
    modelsCache = { at: 0, data: [], ok: true }
  } catch (err) {
    syncState.ok = false
    syncState.error = err.message
    log(`auto-sync failed: ${err.message}`)
  }
  syncState.ms = Date.now() - start
  syncState.running = false
  return syncState
}

// ---- per-IP rate limiting (CWE-770) ---------------------------------------
// Scoped to the inference endpoints only: the dashboard, /health and the
// admin API stay reachable, otherwise the UI's own polling would trip it.
const rateBuckets = new Map()
function rateLimitFor(req) {
  const max = Number(config.rateLimitMax ?? 0)
  if (!Number.isFinite(max) || max <= 0) return { limited: false }
  const window = Number(config.rateLimitWindowMs) > 0 ? Number(config.rateLimitWindowMs) : 60_000
  const key = clientIp(req) || "unknown"
  const now = Date.now()
  let hits = rateBuckets.get(key)
  if (!hits) {
    hits = []
    rateBuckets.set(key, hits)
  }
  while (hits.length && now - hits[0] >= window) hits.shift()
  if (hits.length >= max) {
    return { limited: true, retryAfter: Math.max(1, Math.ceil((hits[0] + window - now) / 1000)) }
  }
  hits.push(now)
  if (rateBuckets.size > 10_000) {
    for (const [k, v] of rateBuckets) if (!v.length || now - v[v.length - 1] >= window) rateBuckets.delete(k)
  }
  return { limited: false }
}

let syncTimer = null
function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer)
  if (!config.autoSync || config.autoSyncIntervalMs <= 0) return
  syncTimer = setTimeout(async () => {
    await syncModels()
    scheduleSync()
  }, config.autoSyncIntervalMs)
  if (syncTimer.unref) syncTimer.unref()
}

// Auto-UA: opencode ships new versions regularly; keeping the injected
// `opencode/<version>` User-Agent current future-proofs the free-tier unlock.
const uaAutoState = { at: 0, version: "" }
async function refreshUA(force = false) {
  if (!config.autoUA) return ""
  const now = Date.now()
  if (!force && uaAutoState.at && now - uaAutoState.at < config.uaRefreshMs) return uaAutoState.version
  uaAutoState.at = now
  try {
    const res = await fetch("https://registry.npmjs.org/opencode-ai/latest", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return uaAutoState.version
    const data = await res.json()
    const v = String(data?.version ?? "")
    if (!/^\d+\.\d+\.\d+/.test(v)) return uaAutoState.version
    uaAutoState.version = v
    const next = `opencode/${v}`
    if (next !== config.ua && /^opencode\/\d+\.\d+\.\d+/.test(config.ua)) {
      log(`auto-UA: opencode ${v} released — updating User-Agent`)
      try { saveConfig({ ua: next }) } catch {}
    }
    return v
  } catch {
    return uaAutoState.version
  }
}

let uaTimer = null
function scheduleUA() {
  if (uaTimer) clearTimeout(uaTimer)
  if (!config.autoUA || config.uaRefreshMs <= 0) return
  uaTimer = setTimeout(async () => {
    await refreshUA()
    scheduleUA()
  }, config.uaRefreshMs)
  if (uaTimer.unref) uaTimer.unref()
}

async function handleModels(req, res) {
  if (!adminAuth(req, res)) return
  const cache = await fetchModels()
  json(res, 200, { object: "list", data: cache.data, ok: cache.ok })
}

function adminAuth(req, res) {
  if (config.proxyKey && bearer(req) !== config.proxyKey) {
    json(res, 401, { error: "unauthorized" })
    return false
  }
  return true
}

async function handleApiConfig(req, res) {
  if (!adminAuth(req, res)) return
  if (req.method === "GET") return json(res, 200, { config: sanitize(config) })
  if (req.method === "POST") {
    // Stop following a pinned list and go back to tracking models.json, so this
    // install sees every catalog refresh from now on. Any hand-added models are
    // dropped — that is what "restore defaults" means. User keys are untouched.
    try {
      const body = await readBody(req)
      const parsed = body ? JSON.parse(body) : {}
      if (parsed.fallbackModels !== true) return json(res, 400, { error: "unsupported action" })
      saveConfig({ fallbackModels: undefined })
      scheduleSync()
      log(`model list restored — now following models.json (${config.fallbackModels.length} models)`)
      return json(res, 200, { ok: true, config: sanitize(config) })
    } catch (err) {
      return json(res, 400, { error: err.message })
    }
  }
  if (req.method === "PUT") {
    try {
      const body = JSON.parse(await readBody(req))
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("body must be a JSON object")
      const cleaned = {}
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (key in body) cleaned[key] = body[key]
      }
      cleaned.port = num(cleaned.port ?? config.port, config.port)
      cleaned.timeoutMs = num(cleaned.timeoutMs ?? config.timeoutMs, config.timeoutMs)
      cleaned.cacheMs = num(cleaned.cacheMs ?? config.cacheMs, config.cacheMs)
      cleaned.autoSyncIntervalMs = num(cleaned.autoSyncIntervalMs ?? config.autoSyncIntervalMs, config.autoSyncIntervalMs)
      cleaned.uaRefreshMs = num(cleaned.uaRefreshMs ?? config.uaRefreshMs, config.uaRefreshMs)
      cleaned.rateLimitMax = num(cleaned.rateLimitMax ?? config.rateLimitMax, config.rateLimitMax)
      cleaned.rateLimitWindowMs = num(cleaned.rateLimitWindowMs ?? config.rateLimitWindowMs, config.rateLimitWindowMs)
      if (cleaned.rateLimitMax < 0) cleaned.rateLimitMax = 0
      if (cleaned.rateLimitWindowMs <= 0) cleaned.rateLimitWindowMs = config.rateLimitWindowMs
      if (cleaned.cacheMs < 0) cleaned.cacheMs = config.cacheMs
      cleaned.trustForwarded = toBool(cleaned.trustForwarded, config.trustForwarded)
      cleaned.autoSync = toBool(cleaned.autoSync, config.autoSync)
      cleaned.autoUA = toBool(cleaned.autoUA, config.autoUA)
      cleaned.injectSession = toBool(cleaned.injectSession, config.injectSession)
      if (cleaned.proxyKey === "••••••••") cleaned.proxyKey = config.proxyKey
      // The list is only ever edited through /api/proxies: what GET returns here
      // is masked, and round-tripping it would overwrite the real credentials.
      delete cleaned.proxies
      if (cleaned.proxyStrategy != null && !PROXY_STRATEGIES.includes(cleaned.proxyStrategy)) cleaned.proxyStrategy = "round-robin"
      if (cleaned.proxyHealthChecks != null) cleaned.proxyHealthChecks = cleaned.proxyHealthChecks === "direct" ? "direct" : "proxy"
      cleaned.proxyCooldownMs = Math.max(0, num(cleaned.proxyCooldownMs ?? config.proxyCooldownMs, config.proxyCooldownMs))
      if (cleaned.probeAuth != null && !["auto", "key", "anonymous"].includes(String(cleaned.probeAuth))) {
        cleaned.probeAuth = "auto"
      }
      if (cleaned.defaultZenKey === sanitize({ defaultZenKey: config.defaultZenKey }).defaultZenKey) {
        cleaned.defaultZenKey = config.defaultZenKey
      }
      if (!Array.isArray(cleaned.fallbackModels)) cleaned.fallbackModels = config.fallbackModels
      // Saving from the dashboard is an explicit edit of the list, so from here on
      // this install owns it rather than tracking models.json.
      else fallbackModelsPinned = true
      if (!Array.isArray(cleaned.responsesModels)) cleaned.responsesModels = config.responsesModels
      if (typeof cleaned.modelAliases !== "object" || cleaned.modelAliases === null) {
        cleaned.modelAliases = config.modelAliases
      }
      saveConfig(cleaned)
      scheduleSync()
      scheduleUA()
      log("config updated via UI")
      return json(res, 200, { config: sanitize(config) })
    } catch (err) {
      if (err && err.statusCode === 413) {
        return json(res, 413, { error: { type: "invalid_request_error", message: "request body too large" } })
      }
      return json(res, 400, { error: err.message })
    }
  }
  return json(res, 405, { error: "method not allowed" })
}

async function handleStatus(req, res) {
  if (!adminAuth(req, res)) return
  const cache = await fetchModels()
  const now = Date.now()
  while (requestStats.window60.length && requestStats.window60[0] < now - 60_000) requestStats.window60.shift()
  const minute = Math.floor(now / 60000)
  const lastMinute = requestStats.window60.length
  let last5m = 0
  for (const [m, c] of requestStats.perMinute) {
    if (minute - m <= 5) last5m += c
  }
  const authMode = config.defaultZenKey ? (config.proxyKey ? "proxy+byok" : "byok") : config.proxyKey ? "proxy" : "public"
  json(res, 200, {
    uptime: Math.floor(process.uptime()),
    upstreamOk: cache.ok,
    upstream: config.upstream,
    ua: config.ua,
    uaAutoVersion: uaAutoState.version,
    defaultModel: config.defaultModel,
    effectiveDefault: effectiveDefault(),
    auth: { mode: authMode, zenKey: maskKey(config.defaultZenKey), proxyKey: !!config.proxyKey },
    responsesModels: [...(config.responsesModels ?? [])],
    rateLimit: { max: config.rateLimitMax, windowMs: config.rateLimitWindowMs },
    probeAuth: config.probeAuth ?? "auto",
    models: {
      total: cache.data.length,
      allowed: ALLOWED().size,
      // false = following models.json, so catalog refreshes apply automatically.
      // true = this install owns its own list.
      followsCatalog: !fallbackModelsPinned,
      served: cache.data.map((m) => m.id),
    },
    sync: {
      ok: syncState.ok,
      at: syncState.at,
      running: syncState.running,
      ms: syncState.ms,
      working: [...syncState.working],
      rateLimited: [...syncState.rateLimited],
      gated: [...syncState.gated],
      flaky: [...syncState.flaky],
      dead: [...syncState.dead],
      // Health learned from real client requests — the only reliable signal for
      // models the free tier hides from the synthetic probe.
      observed: Object.fromEntries(observed),
      error: syncState.error,
    },
    requests: { total: requestStats.total, errors: requestStats.errors, lastMinute, last5m },
    recent: requestStats.recent.map(([k, count, ms]) => ({ ...parseKey(k), count, ms })),
  })
}

function parseKey(key) {
  const [at, model, status] = key.split("|")
  return { at: Number(at), model, status: Number(status) }
}

async function handleTest(req, res) {
  if (!adminAuth(req, res)) return
  try {
    const body = JSON.parse(await readBody(req))
    const model = String(body.model ?? effectiveDefault())
    const start = Date.now()
    // Explicit key override lets the dashboard "test my key" flow verify a typed
    // key before saving it. Falls back to the normal auth path otherwise.
    const auth =
      typeof body.zenKey === "string" && body.zenKey.trim()
        ? `Bearer ${body.zenKey.trim()}`
        : (authForUpstream(req) ?? "Bearer public")
    const format = modelFormat(model)
    const upstreamRes = await upstreamFetch(`${config.upstream}${format === "responses" ? "/responses" : "/chat/completions"}`, {
      method: "POST",
      headers: (() => {
        const h = {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: auth,
          "user-agent": config.ua,
        }
        const sess = sessionHeader(req)
        if (sess) for (const name of SESSION_HEADERS) h[name] = sess
        const ip = req.socket.remoteAddress ?? ""
        if (!ipOmit(ip)) h["x-real-ip"] = ip
        return h
      })(),
      // Same agent-shaped payload the sync probe sends, so TEST reports what a
      // real client would get instead of a gate refusal it never earned.
      body: JSON.stringify(agentProbePayload(model, format)),
      signal: AbortSignal.timeout(config.timeoutMs),
    }, { req, health: true })
    if (upstreamRes.ok) {
      try { await upstreamRes.body?.cancel() } catch {}
    }
    let detail = ""
    let gated = false
    try {
      const parsed = await upstreamRes.json()
      if (format === "responses") detail = parsed.error?.message ?? (typeof parsed.output_text === "string" ? parsed.output_text : "")
      else detail = parsed.error?.message ?? parsed.choices?.[0]?.message?.content ?? ""
      // A FreeTierError on an agent-shaped probe means the gate refused even the
      // shape a real client sends; flag it, but it still may not be the model's
      // fault, so it is reported as gated rather than broken.
      if (upstreamRes.status === 403 && /FreeTierError|free tier can only/i.test(detail)) gated = true
    } catch {}
    json(res, 200, {
      ok: upstreamRes.ok || gated,
      gated,
      model,
      format,
      status: upstreamRes.status,
      ms: Date.now() - start,
      detail: gated ? "the free-tier gate refused even an agent-shaped probe — real agent traffic may still get through" : detail,
    })
  } catch (err) {
    if (err && err.statusCode === 413) {
      return json(res, 413, { error: { type: "invalid_request_error", message: "request body too large" } })
    }
    json(res, 400, { ok: false, error: err.message })
  }
}

function handleLogs(req, res) {
  if (!adminAuth(req, res)) return
  const n = Number(new URL(req.url, "http://x").searchParams.get("n") ?? 200)
  json(res, 200, { logs: logLines.slice(-n) })
}

// GET lists the pool (credentials masked), POST adds one line or a batch,
// DELETE removes one by id or `{"all": true}`.
async function handleProxies(req, res) {
  if (!adminAuth(req, res)) return
  if (req.method === "GET") return json(res, 200, proxyStatus())
  let body
  try {
    body = JSON.parse((await readBody(req)) || "{}")
  } catch {
    return json(res, 400, { error: "invalid JSON body" })
  }
  const current = config.proxies ?? []
  if (req.method === "POST") {
    const scheme = ["http", "https", "socks5"].includes(body.scheme) ? body.scheme : "http"
    const { proxies, errors } = parseProxyList(body.text ?? body.proxies ?? "", scheme)
    const added = proxies.filter((p) => !current.includes(p))
    if (added.length) saveConfig({ proxies: [...current, ...added] })
    if (added.length) log(`proxies: added ${added.length} (${config.proxies.length} total)`)
    return json(res, errors.length && !added.length ? 400 : 200, { added: added.length, duplicates: proxies.length - added.length, errors, ...proxyStatus() })
  }
  if (req.method === "DELETE") {
    const next = body.all === true ? [] : current.filter((u) => proxyId(u) !== body.id)
    if (next.length === current.length && body.all !== true) return json(res, 404, { error: "no such proxy" })
    saveConfig({ proxies: next })
    log(`proxies: removed ${current.length - next.length} (${next.length} left)`)
    return json(res, 200, { removed: current.length - next.length, ...proxyStatus() })
  }
  return json(res, 405, { error: "method not allowed" })
}

// Reaches upstream /models through one proxy (or all of them). A pass lifts
// any cooldown, so a recovered proxy rejoins rotation without waiting it out.
async function handleProxyTest(req, res) {
  if (!adminAuth(req, res)) return
  let body
  try {
    body = JSON.parse((await readBody(req)) || "{}")
  } catch {
    return json(res, 400, { error: "invalid JSON body" })
  }
  const targets = (config.proxies ?? []).filter((u) => !body.id || proxyId(u) === body.id)
  if (body.id && !targets.length) return json(res, 404, { error: "no such proxy" })
  const results = await Promise.all(
    targets.map(async (url) => {
      const t0 = Date.now()
      try {
        const r = await upstreamFetch(`${config.upstream}/models`, { headers: { "user-agent": config.ua }, signal: AbortSignal.timeout(15_000) }, { proxy: url })
        try { await r.body?.cancel() } catch {}
        if (r.ok) Object.assign(proxyStat(url), { cooldownUntil: 0, lastError: "" })
        return { id: proxyId(url), ok: r.ok, status: r.status, ms: Date.now() - t0 }
      } catch (err) {
        return { id: proxyId(url), ok: false, error: err.message, ms: Date.now() - t0 }
      }
    }),
  )
  return json(res, 200, { results, ...proxyStatus() })
}

// Claude Code calls this before a session to size the context window. The real
// Anthropic API tokenises server-side; we approximate from character count,
// which is only used for a progress percentage.
async function handleCountTokens(req, res) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    const e = anthropicError(400, { error: { type: "invalid_request_error", message: "invalid JSON body" } })
    return json(res, e.status, e.body)
  }
  const text = anthropicSystemText(body?.system) + "\n" + (Array.isArray(body?.messages) ? body.messages.map((m) => textOf(m?.content)).join("\n") : "")
  // ~4 characters per token is the usual rule of thumb for English + code.
  const input_tokens = Math.max(1, Math.ceil(text.length / 4))
  return json(res, 200, { input_tokens })
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`)
  const p = url.pathname

  if (req.method === "GET" && (p === "/" || p === "/index.html" || p === "/ui")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    return res.end(uiHtml || "<h1>UI not found</h1>")
  }
  if (req.method === "GET" && p.startsWith("/assets/")) {
    const file = path.join(__dirname, "assets", path.basename(p))
    try {
      const data = fs.readFileSync(file)
      const types = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
      }
      res.writeHead(200, {
        "content-type": types[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "public, max-age=3600",
      })
      return res.end(data)
    } catch {
      return json(res, 404, { error: "not found" })
    }
  }
  if (req.method === "GET" && p === "/health") {
    const cache = await fetchModels()
    return json(res, 200, { ok: cache.ok, upstream: config.upstream })
  }

  if (p.startsWith("/api/")) {
    if (p === "/api/config") return handleApiConfig(req, res)
    if (p === "/api/status" && req.method === "GET") return handleStatus(req, res)
    if (p === "/api/test" && req.method === "POST") return handleTest(req, res)
    if (p === "/api/logs" && req.method === "GET") return handleLogs(req, res)
    if (p === "/api/proxies") return handleProxies(req, res)
    if (p === "/api/proxies/test" && req.method === "POST") return handleProxyTest(req, res)
    if (p === "/api/sync" && req.method === "POST") {
      if (!adminAuth(req, res)) return
      syncModels().then((s) => json(res, 200, { ok: s.ok, ...s }))
      return
    }
    if (p === "/api/reset" && req.method === "POST") {
      if (!adminAuth(req, res)) return
      requestStats.total = 0
      requestStats.errors = 0
      requestStats.recent = []
      requestStats.perMinute.clear()
      requestStats.window60 = []
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: "not found" })
  }

  if (req.method === "GET" && (p === "/v1/models" || p === "/models")) return handleModels(req, res)
  const isInference = p === "/v1/chat/completions" || p === "/chat/completions" || p === "/v1/responses" || p === "/responses"
  const isMessages = p === "/v1/messages" || p === "/messages"
  if (req.method === "POST" && (isInference || isMessages)) {
    // Throttle only the inference endpoints — the dashboard, /health and the
    // admin API must never be locked out by a client's burst.
    const rl = rateLimitFor(req)
    if (rl.limited) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(rl.retryAfter) })
      return res.end(
        JSON.stringify(
          isMessages
            ? { type: "error", error: { type: "rate_limit_error", message: `rate limit exceeded, retry in ${rl.retryAfter}s` } }
            : { error: { type: "rate_limit_error", message: `rate limit exceeded, retry in ${rl.retryAfter}s` } },
        ),
      )
    }
    return isMessages ? handleMessages(req, res) : handleChat(req, res)
  }
  if (req.method === "POST" && (p === "/v1/messages/count_tokens" || p === "/messages/count_tokens")) {
    return handleCountTokens(req, res)
  }
  json(res, 404, { error: { type: "not_found", message: p } })
}

const server = http.createServer(router)

server.requestTimeout = 0
server.headersTimeout = 60_000

// A proxy is a long-lived daemon: one bad request must not take it down for the
// rest of the session. Node kills the process on an unhandled rejection by
// default, and there are fire-and-forget calls here (the stream relays, the
// periodic sync and UA refresh), so a single thrown error used to end the
// server with nothing in the client's face but a connection error. Log it and
// keep serving.
process.on("unhandledRejection", (err) => {
  log(`unhandled rejection (ignored): ${err?.stack || err?.message || err}`)
})
process.on("uncaughtException", (err) => {
  log(`uncaught exception (ignored): ${err?.stack || err?.message || err}`)
})

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${config.port} already in use. Set PORT or edit zen-proxy.json.`)
  } else {
    console.error(err)
  }
  process.exit(1)
})

if (isMain) {
  server.listen(config.port, config.host, () => {
    log(`zen-proxy listening on http://${config.host}:${config.port}`)
    log(`upstream ${config.upstream}  UA ${config.ua}  default ${config.defaultModel || "(auto)"}`)
    log(`config file: ${CONFIG_PATH}  UI: /`)
    if (!fs.existsSync(CONFIG_PATH)) {
      try {
        // fallbackModels is deliberately left out: it comes from models.json, so
        // writing it here would pin this install to today's catalog and it would
        // never see a refresh.
        const { fallbackModels, ...seed } = config
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(seed, null, 2))
        log(`created default config: ${CONFIG_PATH}`)
      } catch {}
    }
    if (config.autoUA) {
      log("auto-UA enabled — checking for new opencode releases…")
      refreshUA()
    }
    if (config.autoSync) {
      log(`auto-sync enabled (every ${Math.round(config.autoSyncIntervalMs / 60000)} min) — probing free models…`)
      syncModels()
    }
    scheduleSync()
    scheduleUA()
  })
}

export {
  isMain,
  parseProxyLine,
  parseProxyList,
  maskProxy,
  proxyId,
  pickProxy,
  proxyStat,
  proxyState,
  proxyStatus,
  upstreamFetch,
  proxiedFetch,
  handleProxies,
  handleProxyTest,
  PROXY_STRATEGIES,
  config,
  loadConfig,
  loadShippedModels,
  isFallbackModelsPinned,
  saveConfig,
  sanitize,
  maskKey,
  resolveModel,
  effectiveDefault,
  modelFormat,
  responsesRequest,
  responsesToChat,
  responsesEventToDeltas,
  usageToChat,
  chatMessagesToInput,
  chatToolsToResponses,
  rateLimitFor,
  probeAuthHeader,
  authForUpstream,
  clientIp,
  ipOmit,
  zenHeaders,
  recordReq,
  requestStats,
  syncState,
  handleChat,
  handleMessages,
  anthropicToChatBody,
  anthropicToChatMessages,
  anthropicToolsToChat,
  chatToAnthropic,
  anthropicError,
  remapAgentTool,
  agentToolsFor,
  loadAgentTools,
  AGENT_TOOL_MAP,
  AGENT_PREAMBLE_TEXT,
  relayStream,
  rewriteSSE,
  fetchModels,
  handleModels,
  handleApiConfig,
  handleStatus,
  handleTest,
  handleLogs,
  logLines,
  router,
  syncModels,
  scheduleSync,
  refreshUA,
  scheduleUA,
  parseRetryAfter,
  retryableUpstream,
  transientUpstream,
  maxBodyBytes,
  toBool,
  sessionFor,
  sessionHeader,
  MAX_BODY,
  VALID_MODEL_ID,
}