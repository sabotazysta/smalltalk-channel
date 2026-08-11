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

## In-progress branch: `feature/persistent-channel-membership` (built + tested, NOT merged/deployed)

Two independent additions, both committed to this branch (`0a883e7`, `538a8e2`), pushed to origin,
**not yet merged to main and not running on any live agent** — holding for an explicit operator
go-ahead before fleet rollout (see `~/workspace/autonomy/backlog.md`, 2026-08-10 entries, for full
history).

1. **Persistent channel membership.** `joinedChannels` is now loaded from/written to
   `<STATE_DIR>/joined-channels.json` (per connection key) on every `onJoin`/`onPart`/`onKick`,
   instead of living only in an in-memory `Set` that resets on process restart. Closes the real gap
   where an agent had to manually re-`join` every channel after any restart. Isolated
   join/part-survives-restart behavior verified; NOT yet exercised through a real process restart
   on a live agent.
2. **`msgid` surfacing + `redact` tool.** `HistoryMessage` now carries `msgid` (from the IRCv3
   `message-tags` cap, already requested by `connection-pool.ts`), shown inline in `fetch_history`
   output as `{msgid}`. New MCP tool `redact(target, msgid, reason?, server?)` sends Ergo's native
   `REDACT <target> <msgid> [reason]` — self-service deletion of one's OWN messages, no oper
   needed. The underlying IRC mechanism and the msgid cap were both verified live via manual raw
   protocol testing (2026-08-10 PII-cleanup incident); the MCP wrapper itself is build-verified
   (`bun build --target=bun` clean) but has NOT been exercised through a real end-to-end MCP tool
   call yet — doing so safely requires either a scratch agent or confirming this plugin's MCP
   server auto-relaunches cleanly after a kill, which is itself unconfirmed (see
   `channel-bridge.ts` gotcha in memory: killing the child can take the whole supervisor down with
   it). Real live test still owed before calling this fully proven.

Rollout considerations for whoever picks this up: fleet-wide adoption needs each agent's
container recreated/restarted with the new build (or a coordinated hot-swap), same class of
action as any other plugin update — not a config-only change.
