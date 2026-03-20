# smalltalk-channel

IRC-based MCP channel plugin for Claude Code.

## Stack

- **MCP plugin**: TypeScript + Bun (`src/server.ts`)
- **IRC server**: Ergo (Go, IRCv3)
- **Web client**: The Lounge
- **Proxy**: Caddy

## Conventions

- Plugin code: TypeScript, Bun runtime, ESM
- No semicolons (match irc-framework style)
- Tests in `tests/`
- Config templates in `config/`

## Running locally

```bash
docker compose up -d
IRC_NICK=myagent IRC_USERNAME=myagent IRC_PASSWORD=secret bun src/server.ts
```

## Adding new tools to the plugin

Follow the pattern in `src/server.ts` — register in `ListToolsRequestSchema` handler and implement in `CallToolRequestSchema` handler.

## File layout

```
src/
  server.ts         # MCP server + IRC bridge
  package.json      # dependencies (irc-framework, @modelcontextprotocol/sdk)
  Dockerfile        # for running plugin in Docker (optional)
config/
  ergo/
    ircd.yaml       # Ergo IRC server config
    tls/            # TLS certs (not committed — generate with openssl)
  caddy/
    Caddyfile       # reverse proxy for The Lounge
scripts/
  create-accounts.sh  # helper: create IRC accounts via SAREGISTER
data/               # runtime data (not committed)
  thelounge/
  caddy/
```

## Environment variables

The plugin reads `~/.claude/channels/smalltalk/.env` first, then environment. Required: `IRC_NICK`, `IRC_USERNAME`, `IRC_PASSWORD`. See README for full list.

## Known gotchas

- Ergo must be started with TLS certs already in place (`config/ergo/tls/`)
- Admin oper password in `ircd.yaml` is a bcrypt hash — generate with `ergo genpasswd`
- The Lounge needs web UI setup on first run
- CHATHISTORY is in-memory by default (not persistent across Ergo restarts); add MySQL for persistence
