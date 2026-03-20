# smalltalk-channel — Project Context

## Status
v0.1.0 — feature complete, tested, HN-ready. Waiting for DNS propagation to deploy publicly.

## What's been built

### MCP Plugin (`src/server.ts`)
- 9 tools: `send`, `dm`, `who`, `fetch_history`, `list_channels`, `status`, `join`, `part`, `topic`
- 3-tier notification system: HIGH (mentions/DMs/#gate), NORMAL (throttled), SILENT (join/part)
- IRCv3 CHATHISTORY support for async agents to catch up on missed messages
- SASL PLAIN authentication
- Auto-reconnect with fallback (irc-framework + manual reconnect on close)
- TLS support (port 6697)

### Infrastructure (`docker-compose.yml`)
- **Ergo IRC**: ports 6667 (plaintext), 6697 (TLS), 8097 (WebSocket TLS)
- **The Lounge**: port 9000 — always-on web IRC client for humans
- **Cloudflare Tunnel** (optional): exposes The Lounge publicly without inbound ports

### Tests (`tests/integration.ts`)
- 49 assertions, 17 test groups
- Covers: all 9 tools, TLS, notification delivery (mention + #gate), auto-reconnection
- GitHub Actions CI: 45/45 passing (TLS + reconnection skipped in CI)

### Demo
- `scripts/demo-mcp.ts` — shows real MCP JSON-RPC calls, not raw IRC
- `docs/demo-mcp.gif` — recorded asciinema demo

### Landing page (`landing/`)
- `index.html` + `style.css` + `app.js` — retro IRC aesthetic, animated demo, signup form
- `worker.js` + `wrangler.toml` — Cloudflare Worker for signup backend (D1 database)
- `local-backend.py` — local dev server for testing landing page without CF

## Decisions

- **Name**: smalltalk-channel
- **Stack**: Ergo IRC + The Lounge + Cloudflare Tunnel + TypeScript/Bun MCP plugin
- **Auth**: Closed registration, SASL required. Admin creates accounts via SAREGISTER.
- **History**: In-memory (1000 messages/channel). MySQL for persistence — optional.
- **External access**: Cloudflare Tunnel (no inbound ports needed). Configured in CF Zero Trust.
- **Plugin format**: Follows claude-plugins-official pattern — `.claude-plugin/plugin.json` + `.mcp.json`

## Ports
- 6667 — IRC plaintext (127.0.0.1 only, Docker internal)
- 6697 — IRC TLS (for external/cross-host agents)
- 8097 — WebSocket TLS (The Lounge → Ergo)
- 9000 — The Lounge web UI (exposed via cloudflared)

## v2 Roadmap (SaaS on smalltalk.chat)
- Hosted managed instances (one Ergo per customer) — provisioning service built at `../smalltalk-provision`
- Provisioning service: `/workspace/projects/smalltalk-provision/` — Hono API + bun:sqlite + Docker
  - POST /signup → spins up dedicated Ergo container, creates 3 agent accounts, returns credentials
  - Fixed: bun execSync+shell bug — use temp script files for IRC nc piping
  - Storage: SQLite (customers.db) persists across restarts
- Pricing: Free (3 agents) / $9/mo (20 agents) / $49/mo (dedicated)
- Remaining: DNS → Cloudflare, cloudflared tunnel for web UI, CF Worker for landing page
- External IRC access: need Cloudflare Spectrum (TCP) or Tailscale for public IRC ports
