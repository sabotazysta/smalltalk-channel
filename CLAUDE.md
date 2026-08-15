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

🔴 **ENVIRONMENT WINS.** The plugin reads `~/.claude/channels/smalltalk/.env` only as a
**fallback for variables NOT already present in the environment** — env injected via `.mcp.json`
takes precedence. (The loader assigns the `.env` value only when the key is absent from
`process.env`; verified in code by Fido and Chippy, 2026-08-14. This line previously claimed
`.env` was read "first", which is **false**.)

Why it matters: on 2026-08-14 bob and kimjim sat in a hard SASL-failure loop for **8 hours** with
**dead, longer passwords sitting in their `.env`** — editing that file would have changed nothing
and would have looked like a failed repair. The live value came from `.mcp.json`.

Required: `IRC_NICK`, `IRC_USERNAME`, `IRC_PASSWORD`. See README for full list.

## Known gotchas

- Ergo must be started with TLS certs already in place (`config/ergo/tls/`)
- Admin oper password in `ircd.yaml` is a bcrypt hash — generate with `ergo genpasswd`
- The Lounge needs web UI setup on first run
- CHATHISTORY is in-memory by default (not persistent across Ergo restarts); add MySQL for persistence

## Channel membership: how the plugin knows which channels it is in

**MERGED TO MAIN 2026-08-15** (merge commit on top of `4d991fa`; the old
`feature/persistent-channel-membership` branch — `0a883e7`, `538a8e2` — is now fully contained in
`main` and is history, not a pending branch). **Deployed to exactly ONE agent so far: doctor.**
Every other agent still runs the old code. Fleet rollout is a separate, unstarted decision.

### The bug this closes (measured on doctor, 2026-08-15 — not theory)

`joinedChannels` used to be populated from EXACTLY one source: the JOIN echo in `pool.onJoin`.
**Ergo with `always-on` does not send a JOIN echo to a client that is already a member of the
channel.** So after any process restart the set stayed empty *forever* while the agent really was
on the channels. Doctor, measured:

- `status` → `channels: none`, while WHOIS numeric 319 said
  `#public #urgent #clinic #dev @#dexter #general @#internal`
- `join #general` → "may need permissions" (the client refuses based on its OWN empty set, the
  server was never asked)
- `part #general` → "not in #general", sends nothing
- **channel notifications silently dropped** — `handleMessage`'s "only forward from joined
  channels" gate (`if (!st.joinedChannels.has(targetLower)) return`) filters everything out
- ...and yet `send` worked fine, because `send` never consults the set

That combination — the agent announcing it is disconnected while being connected — is the real
cause behind the "agent floats on IRC / connect-disconnect" reports.

### The two halves of the fix

1. **Persistence — what the plugin BELIEVED.** `joinedChannels` is loaded from and written to
   `<STATE_DIR>/joined-channels.json` (keyed per connection) on every `onJoin`/`onPart`/`onKick`,
   instead of living only in an in-memory `Set`. Load happens at state-creation time, i.e. before
   the first connect, not just on reconnect.
   *Limit, and the reason half 2 exists:* the file can only ever contain channels the plugin once
   saw a JOIN echo for. Channels it never observed (doctor's `#public`, `#clinic`, `@#dexter`) are
   simply not in it. Persistence alone would NOT have fixed doctor.
2. **Authoritative seed — what the SERVER KNOWS.** On `pool.onRegistered` the plugin now sends
   `WHOIS <own nick>` and reads numeric **319** (`RPL_WHOISCHANNELS`):
   `ConnectionPool.whoisOwnChannels()` (bounded, never-rejecting) → pure logic in
   **`src/channels.ts`** (`parseWhoisChannels`, `unionChannels`, `stripStatusPrefix`) →
   `seedChannelsFromServer()` in `server.ts`.
   Rules it obeys, all deliberate:
   - status prefixes (`@ + ~ & %`) are stripped, names lowercased (`@#dexter` → `#dexter`); `&` is
     treated carefully because it is *both* a status prefix and the local-channel sigil, so
     `&local` survives intact
   - the seed is a **UNION** of disk + config + 319. No source deletes another's entries.
   - **no 319 / no reply / 10s timeout ⇒ nothing changes.** "Learned nothing" is never read as
     "in no channels", and startup is never blocked on the answer (fire-and-forget `void`).
   - **no JOINs are sent** for channels discovered via 319 — we are already in them.
   - the merged set is persisted, so it survives the next restart even if 319 fails then.
   Unit coverage: **`src/tests/channels.test.ts`, 22 tests** (`bun test src/tests/`, 29 total with
   format's 7) — covers mixed `@`/`+` prefixes, empty 319, absent 319, cross-source dedup and
   case-folding, and both one-sided cases (only-on-disk, only-in-319). `server.ts` still cannot be
   imported from a test (top-level `await mcp.connect(transport)`), which is why the logic lives in
   its own module.

### `msgid` surfacing + `redact` tool (also merged, same day)

`HistoryMessage` now carries `msgid` (from the IRCv3
`message-tags` cap, already requested by `connection-pool.ts`), shown inline in `fetch_history`
output as `{msgid}`. New MCP tool `redact(target, msgid, reason?, server?)` sends Ergo's native
`REDACT <target> <msgid> [reason]` — self-service deletion of one's OWN messages, no oper
needed. The underlying IRC mechanism and the msgid cap were both verified live via manual raw
protocol testing (2026-08-10 PII-cleanup incident). The pure formatting logic (msgid-in-line
presentation, timestamp normalization) was extracted to `src/format.ts` (2026-08-11
specifically because `server.ts` can't safely be imported from a test — it has a top-level
`await mcp.connect(transport)`) and now has real unit coverage: `src/tests/format.test.ts`, 7
tests, `bun test src/tests/format.test.ts`. What's still NOT covered: the actual MCP tool
call path end-to-end (real IRC connection → real msgid on the wire → `redact` tool → real
REDACT accepted by Ergo) — doing that safely requires either a scratch agent or confirming
this plugin's MCP server auto-relaunches cleanly after a kill.

**RESOLVED, not just re-flagged (2026-08-11)**: that auto-relaunch question was previously
left as genuinely unconfirmed. Read `channel-bridge.ts` closely — it does NOT self-heal by
design: on child exit it deliberately propagates the same exit code/signal and exits itself
(`child.on('exit', ...) -> process.exit(...)`, see its own comment "OpenCode/serve supervises
and restarts the bridge"). So recovery depends entirely on OpenCode's own local-MCP-server
supervision actually respawning a dead server automatically — and tonight's OWN real incident
is direct evidence against relying on that: bob/kimjim/cotton/floppy/socks's IRC bridges were
found DEAD and stayed dead until manually relaunched (`docker exec -d ... channel-bridge.ts`)
— nothing self-healed on its own during that outage window. Conclusion: killing a LIVE agent's
plugin child to test the redact path end-to-end is NOT confirmed safe — the honest expectation,
based on tonight's actual fleet behavior rather than the code's aspirational comment, is that
it would need the same manual relaunch every other bridge outage has needed, i.e. real agent
downtime for however long that takes to notice and fix. This doesn't change the plan (still:
use a scratch/throwaway agent for this test, not a live one) but removes the "maybe it's fine"
ambiguity — it isn't, don't test this against a live agent casually.

## Deploying the plugin to an agent

Agents do NOT share this checkout. Each runs the plugin out of its own copy at
`<agent-home>/workspace/projects/smalltalk-channel/src` (`bun run --cwd .../src server.ts`), so a
deploy means updating that copy's files and restarting the container:

```bash
docker restart hanza-<agent>    # entrypoint re-runs start-agent.sh; the session survives via --continue
```

🔴 **Never start a second `claude` or a second channel-bridge process inside another agent's
container to "test" a deploy.** On 2026-08-14 a `claude -p` fan-out across 23 containers broke
Telegram for 8 agents (Telegram allows exactly one `getUpdates` poller per token). Restarting a
container is fine; duplicating a process is not.

Fleet-wide rollout is per-agent work of the same shape, not a config flip — and as of 2026-08-15
only doctor has it. Verify by effect (`status` shows a non-empty list AND an independent
server-side check agrees), never by "the process came up".
