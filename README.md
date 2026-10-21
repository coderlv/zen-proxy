<p align="center">
  <img src="assets/logo.png" width="96" alt="zen-proxy" />
</p>

<p align="center"><b>zen-proxy</b></p>
<p align="center">Use OpenCode Zen's free models from any AI coding agent.</p>
<p align="center"><sub>No account. No API key. OpenAI&nbsp;and&nbsp;Anthropic&nbsp;compatible. Runs on your machine.</sub></p>

<p align="center">
  <a href="https://discord.gg/Dw5Ctrtuw">
    <img src="https://img.shields.io/badge/Discord-Join%20the%20server-5865F2?style=flat-square&labelColor=1a1612&logo=discord&logoColor=white" alt="Join the Discord server">
  </a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-ccf73a?style=flat-square&labelColor=1a1612" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-8b8b8b?style=flat-square&labelColor=1a1612" alt="Node 18+">
  <img src="https://img.shields.io/badge/dependencies-0-8b8b8b?style=flat-square&labelColor=1a1612" alt="Zero dependencies">
  <a href="#any-openai-compatible-agent">
    <img src="https://img.shields.io/badge/OpenAI_compatible-8b8b8b?style=flat-square&labelColor=1a1612&logo=openai" alt="OpenAI compatible">
  </a>
  <a href="#claude-code">
    <img src="https://img.shields.io/badge/Claude_Code-compatible-8b8b8b?style=flat-square&labelColor=1a1612&logo=anthropic" alt="Claude Code compatible">
  </a>
</p>

---

## Start here

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/12errh/zen-proxy/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/12errh/zen-proxy/main/install.ps1 | iex
```

<sub>That is the entire installation — no account, no API key, no `npm install`. Now pick your agent below.</sub>

---

### Claude Code

```bash
zen-claude
```

<sub>Identical on Linux, macOS and Windows.</sub>

It starts the proxy if it is not already running, loads every live free Zen model into Claude Code's `/model` picker, runs Claude Code, and stops the proxy again when you exit. Your existing Claude Code config is never touched.

---

### Any OpenAI-compatible agent

<sub>Cline, Roo Code, Continue, Aider, mimo, opencode forks — anything with a `baseURL` setting.</sub>

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| API key | `public` |
| Model | anything from `GET /v1/models` |

Confirm the proxy is up:

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"upstream":"https://opencode.ai/inference/v1"}
```

<details>
<summary>Run the proxy yourself</summary>

```bash
zen-proxy     # http://127.0.0.1:8787 — dashboard at /
```

It stays up until you stop it, so you point your agent at it once and keep using it. `zen-claude` does this for you and cleans up after.
</details>

---

## What you get

| | |
|---|---|
| `POST /v1/chat/completions` | OpenAI, streaming and not |
| `POST /v1/responses` | OpenAI Responses API, translated both ways — a body that speaks Responses gets Responses back, a chat body keeps its chat reply |
| `POST /v1/messages` | Anthropic Messages API — **this is the Claude Code one** |
| `POST /v1/messages/count_tokens` | Anthropic token estimate |
| `GET /v1/models` | What's live right now |
| Automatic fallback | Retries the next free model on `429` / `5xx` / unavailable |
| Model aliases | Call it `gpt-4o`, get a free model back |
| Auth | Anonymous `Bearer public`, or bring your own Zen key |
| Outbound proxies | HTTP / HTTPS / SOCKS5 pool with round-robin, random, sticky, least-used or failover rotation |
| Token analytics | Input / cached / output / reasoning tokens per period, TTFT and tokens/s per model, cache hit per session mode |
| Dashboard | `http://127.0.0.1:8787/` |

The free-model catalog in [`models.json`](models.json) is refreshed from OpenCode's public catalog by a GitHub Action every 6 hours.

---

## Why a proxy is needed

OpenCode's free models are served only to the OpenCode CLI itself. Everyone else gets:

```
403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
```

zen-proxy sits in front of that gateway and identifies your agent as a real session.

<details>
<summary>What it actually changes</summary>

| Gateway requirement | What zen-proxy does |
|---|---|
| `x-opencode-session` **and** `x-opencode-session-id`, same value | Mints a stable per-client id and sends both |
| The id must look real — its first 12 hex chars encode a timestamp | Generates ids in OpenCode's own format, not random hex |
| Base must be `https://opencode.ai/inference/v1` | Uses it, and migrates configs still pointing at the retired `/zen/v1` |
| Streaming, a system message, tool definitions | Real agents already send these; the proxy fills gaps where it can |

For `/v1/messages` specifically, the gateway also requires OpenCode's own tool manifest, so zen-proxy attaches those tools alongside Claude Code's and renames the resulting calls back. **Claude Code's system prompt is passed through untouched.**

The OpenAI-shaped routes get no name mapping, so they are handled differently: a request carrying **no tools at all** — an agent's own internal call, like summarization or title generation — is given OpenCode's own tool manifest so it passes the gate, exactly as opencode sends it on every call. The gateway does not honour `tool_choice: "none"` — it answers a plain summarization prompt with real `read` calls — so any tool call is stripped from the reply instead, on both OpenAI-shaped routes.

A request that brings **its own tools** and pins one of them with `tool_choice` — a forced-tool helper, like a title or label call — needs the same `read` in the list, or the gateway refuses the whole request. The proxy adds a **stub** named `read` for exactly those calls: the gate looks at the tool's name and nothing else, and the pin is what makes it safe to add one, because a caller that pins a function cannot be asked for anything else. Your tool list and your pin are forwarded untouched.

The pin is not enforcement, though — the gateway hands it to the provider, and the provider may still answer with a call you never offered. The stub is deliberately a stub for that reason: OpenCode's own `read` schema invites the model to call it, and a pinned helper that comes back with a stray `read` is a tool your client cannot run. So a pinned reply is **filtered down to the pinned call** — on all three routes, streaming included — and a reply whose every call got dropped ends as a plain stop instead of claiming a tool call that does not exist. An unpinned agent turn is never filtered.
</details>

<details>
<summary>Gotchas worth knowing before you file a bug</summary>

- **This rides an anonymous free tier.** Per-IP quotas, shared pool, sometimes saturated. Bring a key if you need reliability.
- **A bare `curl` gets `403`.** The gateway only answers genuine *agent* traffic. Every agent above does this; a hand-rolled chat client won't.
- **Health probes are agent-shaped.** Sync sends each model the same thing a real client sends — opencode's tool manifest plus `stream: true` — so `ok` means the model genuinely answered. A model marked `gate-blocked` is one the free-tier gate refused even for that shape; blocks lift on their own and the model is never dropped. Real traffic is still tracked on top (`ok (live traffic)`).
- **Probing tells real health; the catalog tells existence.** A retired model answers `400 Model is unavailable` and is not added, while a live one answers with a stream — so the list reflects what actually works, not just what upstream advertises.
- **Fallbacks announce themselves** via `zen_served_by` and the `x-zen-served-by` / `x-zen-fallback` headers, and every failed model attempt is logged with its status and upstream message (dashboard Logs), so a frequent fallback can be traced to its cause.
- **Thinking is passed back on tool turns.** On `/v1/messages` an assistant turn with tool calls goes upstream as one message with its `reasoning_content`; DeepSeek's thinking mode answers `400` otherwise, which used to send every agent loop to the next model.
- **`agent-tools.json` is a capture of OpenCode's tools.** If OpenCode changes its tool schemas, the `/v1/messages` bridge may stop satisfying the gateway. Re-capture it from any OpenCode request.
</details>

---

## Configuration

`zen-proxy.json`, created on first run, hot-reloaded, and editable from the dashboard. Environment variables override at startup.

Where things live — outside the install dir, so a reinstall or `git pull` never touches them:

| | Linux / macOS | Windows |
|---|---|---|
| Config | `~/.config/zen-proxy/zen-proxy.json` (`$XDG_CONFIG_HOME`) | `%APPDATA%\zen-proxy\zen-proxy.json` |
| Analytics | `~/.local/share/zen-proxy/stats.json` (`$XDG_DATA_HOME`) | `%LOCALAPPDATA%\zen-proxy\stats.json` |

`ZEN_PROXY_CONFIG` and `ZEN_PROXY_STATS` override both; with only `ZEN_PROXY_CONFIG` set, analytics go next to that file. Builds before this kept `zen-proxy.json` (and `zen-proxy-stats.json`) beside `zen-proxy.mjs`: the proxy and the installers move them on first start, renaming the old file to `*.migrated` (proxy) or keeping it as `*.from-install-dir` if the new location already had one (installer). The startup log prints both paths.


<details>
<summary>Keys</summary>

| Key | Default | Description |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8787` | Bind address (restart required) |
| `upstream` | `https://opencode.ai/inference/v1` | Zen gateway base |
| `ua` / `autoUA` | `opencode/1.18.30` / `true` | User-Agent sent upstream; auto-tracks OpenCode releases |
| `injectSession` | `true` | Mint and send the session header pair |
| `agentTools` | `true` | Attach OpenCode's tools to `/v1/messages`, and to tool-less requests on the OpenAI-shaped routes |
| `defaultModel` | `""` | Empty = auto-pick the first working free model |
| `fallbackModels` | *(from [`models.json`](models.json))* | Tried in order on failure. Omit to follow the catalog; save once to pin your own list |
| `modelAliases` | `{}` | e.g. `{"gpt-4o": "space-bunny-free"}` |
| `responsesModels` | `["gpt-5*","gpt-6*","grok-*","muse-spark-*"]` | Models served on `/v1/responses`; patterns may end in `*` |
| `defaultZenKey` | `""` | Your own Zen key instead of anonymous `public` |
| `proxyKey` | `""` | Require this from clients; also locks the dashboard and `/api/*` |
| `rateLimitMax` / `rateLimitWindowMs` | `0` (off) / `60000` | Per-client rate limiting |
| `timeoutMs` / `cacheMs` | `120000` / `30000` | Upstream timeout, `/v1/models` cache TTL |
| `autoSync` / `autoSyncIntervalMs` | `true` / `3600000` | Runtime discovery of newly-offered free models |
| `trustForwarded` | `false` | Honour `x-forwarded-for` behind a reverse proxy |
| `proxies` | `[]` | Outbound proxy URLs; manage them in the dashboard's Proxies tab or via `/api/proxies` |
| `disabledProxies` | `[]` | Ids of proxies kept in the list but out of rotation; toggled from the dashboard or `PATCH /api/proxies` |
| `proxyStrategy` | `round-robin` | `round-robin`, `random`, `sticky`, `least-used` or `failover` |
| `proxyCooldownMs` | `60000` | How long a failing or rate-limited proxy sits out |
| `proxyRetries` | `3` | Extra proxies one request tries after a dead tunnel, a stream cut before its first byte, or a `429` (0–20) |
| `proxyFirstByteMs` | `90000` | A proxy that sends no first byte (headers included) in this time is dropped for the next one; `0` turns it off |
| `proxyHealthChecks` | `proxy` | `proxy` or `direct`: how probes, sync, model TEST, `/health` and `/v1/models` reach upstream |
| `proxySessionMode` | `per-proxy` | `per-proxy`: each proxy gets its own session id. `per-client`: one session per client, only the IP rotates |

`HOST` `PORT` `ZEN_URL` `ZEN_UA` `INJECT_SESSION=0` `AUTO_UA=0` `UA_REFRESH_MS` `AGENT_TOOLS=0` `PROBE_AUTH` `DEFAULT_MODEL` `FALLBACK_MODELS` `MODEL_ALIASES` `RESPONSES_MODELS` `PROXY_KEY` `ZEN_KEY` `TRUST_FORWARDED=1` `TIMEOUT_MS` `CACHE_MS` `RATE_LIMIT_MAX` `RATE_LIMIT_WINDOW_MS` `AUTO_SYNC=0` `AUTO_SYNC_MS` `PROXIES` (comma-separated) `PROXY_STRATEGY` `PROXY_COOLDOWN_MS` `PROXY_RETRIES` `PROXY_FIRST_BYTE_MS` `PROXY_HEALTH_CHECKS=direct` `PROXY_SESSION_MODE=per-client` `ZEN_PROXY_CONFIG` `ZEN_PROXY_STATS` (analytics file path)

Anonymous `public` access shares a per-IP quota that is sometimes saturated. Set `defaultZenKey`, or send `x-zen-key` per request, for steadier service.
</details>

<details>
<summary>Outbound proxies and rotation</summary>

Upstream traffic can leave through a pool of proxies instead of your own IP. Manage it from the dashboard's **Proxies** tab: paste one proxy or a whole batch, pick a rotation strategy, check each proxy with one click, and **Disable** / **Enable** one to take it out of rotation without deleting it. A summary above the list shows how many proxies are live, cooling down and off, and what benched them in the last hour (connection, stream cut, no first byte, 429, proxy auth 407, other), so a pool of thousands reads at a glance. No proxies configured means traffic goes direct, exactly as before. Disabling every proxy does not go direct: requests fail until one is enabled again, and only **Remove all** means direct.

Accepted lines (one per line, or comma-separated):

```
1.2.3.4:8080                      # scheme taken from the dropdown (http by default)
1.2.3.4:8080:user:pass            # the usual seller export
user:pass@1.2.3.4:8080
socks5://user:pass@proxy.example:1080
https://user:pass@proxy.example:443
```

HTTP, HTTPS (TLS to the proxy) and SOCKS5 with username/password are supported. The tunnels are built on Node's own `net`/`tls`, so there are still zero dependencies.

| Strategy | Picks |
|---|---|
| `round-robin` | the next proxy on every request and every retry |
| `random` | any live proxy |
| `sticky` | the same proxy for one client (its session id) until that proxy fails |
| `least-used` | the live proxy with the fewest requests so far |
| `failover` | always the first live proxy, the next one only after a failure |

A proxy that fails to connect, rejects its credentials, drops the stream, hangs past `proxyFirstByteMs` without a first byte, or gets a `429` from upstream sits out `proxyCooldownMs`. The same request is then retried right away on the next proxy, up to `proxyRetries` times, without spending the model's retries or falling back to another model; when those run out it fails with `503`. A stream cut after the first byte has already reached the client cannot be replayed: the proxy is benched, and the client gets an in-band error instead of a reply that just stops (an `error` event on `/v1/messages`, a `data: {"error":…}` chunk on `/v1/chat/completions`). Upstream sends its headers only with the first token, so the first-byte timeout stays generous: a big context on a slow free model can take a minute. `403` responses do not bench a proxy: they come from the free-tier gate, not from the IP. When every proxy is cooling down, requests fail with `503` instead of quietly going out from your own IP. A successful **Check** brings a proxy back early.

By default each proxy gets its own `x-opencode-session` id, so a new exit IP also looks like a new session upstream rather than the same client on a different address. Set `proxySessionMode` to `per-client` to keep one session per client and rotate only the IP; the Analytics tab compares what each mode does to the prompt cache. A session the client sends itself is left untouched either way.

Proxied response bodies are read with backpressure: when the reader falls behind, the tunnel stops reading and upstream is held back over TCP, so a large body is not buffered in memory.

`proxyHealthChecks` decides how model probes, sync, the model **TEST** button, `/health` and `/v1/models` reach upstream: `proxy` (through the pool) or `direct`. Use `direct` to tell a dead model from a dead proxy. The npm lookup behind `autoUA` always goes direct.

Passwords are masked everywhere they are shown (dashboard, `/api/config`, `/api/proxies`, logs) and kept only in your `zen-proxy.json`. Remote (non-local) clients still have their IP forwarded as `x-real-ip`, as before. Respect OpenCode's terms and quotas.
</details>

<details>
<summary>Token analytics</summary>

The dashboard's **Analytics** tab answers two questions: how many tokens went through, and which model answers faster.

- **Periods**: Today, 24h, 7d, 30d, All. Each figure is compared with the window just before it ("Today" with yesterday up to the same hour).
- **Tokens**: input, how much of it came from the provider's prompt cache, output, and the reasoning share of the output. A stacked chart shows them per hour (Today, 24h) or per day (7d, 30d, All).
- **Models**: calls, tokens, cache hit, average **time to first token** (thinking included) and average **tokens/s** (output tokens over the time spent streaming them), plus the error rate, sortable. A scatter of TTFT against tok/s puts the fastest models top left.
- **Failed calls**: a chart of failed calls per hour or day by cause: 429, other upstream 4xx, upstream 5xx, network / proxy (connection failed, timed out or the stream was cut), no live proxy, and aborted (the client hung up; shown, but not counted as an error). Hover a model's error rate for the same split. Calls recorded before causes were tracked show as "unknown".
- **Cache by session mode**: every call is tagged with the session mode it went out in (`proxySessionMode`, or `direct` without proxies). The cache hit, 429s and TTFT of each mode sit side by side, so you can see whether rotating the session with the proxy costs you the prompt cache.

Counts come from the `usage` the upstream stream reports; nothing is estimated. Only client traffic is metered, not probes or model tests. "Calls" are upstream attempts, retries included. Note that tool-less requests carry OpenCode's tool manifest (see below), which shows up as input tokens, mostly cached.

The **Recent requests** feed on the Overview tab shows the same counts per request: time to first token, tokens/s, input, cache hit, output and reasoning tokens. Above the table you can show errors only, or one model (each hop of a fallback counts). A row marked ▸ expands on click to every failed model attempt behind it with its error, so a fallback to another model says why it happened, and to the proxy that carried it plus every proxy that failed before it and why. Slow because of the model or because of the proxy is one click away.

Data is kept in `stats.json` in the zen-proxy data dir (see Configuration), saved every 30 seconds and on shutdown. Hourly detail is kept for 31 days; older hours fold into one bucket per day, so the file stays small. `GET /api/analytics?range=today|24h|7d|30d|all` returns the same numbers as JSON.
</details>

<details>
<summary>Dashboard</summary>

`http://127.0.0.1:8787/` — upstream health and uptime, a live request feed, token analytics, one-click model testing, the outbound proxy pool, instant config editing, and a log tail.

![zen-proxy dashboard](assets/dashboard.png)
</details>

<details>
<summary>HTTP API</summary>

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `POST` | `/v1/messages` | Anthropic Messages API |
| `POST` | `/v1/messages/count_tokens` | Anthropic token estimate |
| `GET` | `/v1/models` | Available models |
| `GET` | `/health` | Health check (always open) |
| `GET` | `/` | Dashboard |
| `GET`/`PUT` | `/api/config` | Read / update configuration |
| `GET` | `/api/status` | Stats and upstream health |
| `POST` | `/api/test` | Test one model — `{"model":"..."}` |
| `GET` | `/api/logs` | Log tail |
| `POST` | `/api/sync` | Re-run model discovery |
| `POST` | `/api/reset` | Reset request statistics |
| `GET` | `/api/analytics` | Token and speed analytics — `?range=today\|24h\|7d\|30d\|all` |
| `GET` | `/api/proxies` | Proxy pool with per-proxy stats (credentials masked) |
| `POST` | `/api/proxies` | Add proxies — `{"text":"one or many lines","scheme":"http\|https\|socks5"}` |
| `PATCH` | `/api/proxies` | Take one in or out of rotation — `{"id":"...","enabled":false}` |
| `DELETE` | `/api/proxies` | Remove one — `{"id":"..."}` — or all — `{"all":true}` |
| `POST` | `/api/proxies/test` | Reach upstream through one proxy (`{"id":"..."}`) or all of them (`{}`) |
</details>

<details>
<summary>Running as a service (Linux)</summary>

`install.sh` offers to install a systemd unit, or:

```bash
sudo systemctl enable --now zen-proxy
```
</details>

<details>
<summary>Doing it by hand instead of using <code>zen-claude</code></summary>

Both launchers pass `--settings` rather than exported env vars — **Claude Code reads env from `~/.claude/settings.json`, and that wins over your shell**, so an `export` is silently ignored if that file already sets `ANTHROPIC_BASE_URL`. Your existing config is left alone; a plain `claude` still uses it.

```bash
claude --settings ./claude/zen-proxy.settings.json
```

The generated picker comes from `bin/make-settings.mjs`, which reads the live model list from the proxy (falling back to `models.json`). Each row sets `behavesAs` so Claude Code handles an unfamiliar model id sensibly while still sending that exact id upstream.

If `zen-claude` says `command not found`, check `ls -l ~/.local/bin/zen-claude` first — if the symlink is missing, re-run the installer. Only if it exists is it a stale `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"                          # this terminal
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc      # permanent
```
</details>

---

<p align="center">
  <sub>💬 <a href="https://discord.gg/Dw5Ctrtuw">Join the Discord</a> — install help, troubleshooting, and which free model is fast right now.</sub>
</p>

<p align="center">
  <sub>Machine-readable: <a href="llms.txt">llms.txt</a> &nbsp;·&nbsp; <a href="llms-full.txt">llms-full.txt</a></sub>
</p>

<p align="center">
  <a href="https://github.com/12errh/zen-proxy/issues">
    <img src="https://img.shields.io/github/issues/12errh/zen-proxy?style=flat-square&labelColor=1a1612&color=8b8b8b" alt="Open issues">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-8b8b8b?style=flat-square&labelColor=1a1612" alt="MIT License">
  </a>
</p>