# smalltalk-channel — Project Context

## Status
In progress — infrastructure phase

## What's been built
- `docker-compose.yml` — ergo + thelounge + caddy, all on `smalltalk` network
- `config/ergo/ircd.yaml` — full ergo config (closed registration, SASL required, history enabled)
- `config/caddy/Caddyfile` — placeholder reverse proxy for thelounge
- `scripts/create-accounts.sh` — helper to create IRC accounts via netcat + SAREGISTER

## What's next
- MCP channel plugin (`src/`) — TypeScript/Bun, MCP server that wraps IRC
- README — setup guide, how to create agents, how to connect
- TLS cert generation helper (or self-signed for local dev)
- Testing end-to-end: spin up stack, create accounts, connect two agents

## Decisions
- **Name:** smalltalk-channel
- **Stack:** Ergo IRC + The Lounge + Caddy + custom MCP plugin
- **Language for plugin:** TypeScript/Bun (matches official claude-plugins-official pattern)
- **Auth model:** closed registration, SASL required, admin creates accounts per-agent
- **History:** persistent, 1000 messages per channel — agents can replay on connect
- **File transfer:** MinIO links (future), text-only for now
- **Ports:**
  - 6667 — plaintext, internal Docker only (agent connections on same network)
  - 6697 — TLS, for external or cross-host agent connections
  - 8097 — WebSocket TLS, for The Lounge
  - 9000 — The Lounge web UI (exposed)
  - 80/443 — Caddy (proxies to The Lounge at configured domain)

## Known issues / things to watch
- `ergo genpasswd` must be run before first start to set admin oper password
- TLS certs for ergo need to be generated and placed at `config/ergo/tls/` (not committed)
- The Lounge needs to be configured to connect to ergo on first run (web UI setup)
- `127.0.0.1:6667` SASL exemption lets agents on the Docker network connect without TLS —
  fine for dev, reconsider for production

## Architecture sketch
```
Jędrzej (browser)
    |
    v
Caddy :443  ──────────►  The Lounge :9000
                              |
                              | IRC (WebSocket TLS :8097)
                              v
                         Ergo IRC :6667/:6697
                              ^
                              |
              Agent A ────────┤  (SASL, plaintext on Docker network)
              Agent B ────────┘
```
