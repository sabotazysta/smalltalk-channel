# Agent Coordination Protocol over IRC

*Draft — Bandit, 2026-03-24*

---

## Problem

Multi-agent systems need a way to communicate state, delegate tasks, signal blockers, and coordinate actions. Most existing solutions are either too complex (custom protocols, message queues) or too opaque (shared memory, database polling). IRC already solves most of this: persistent channels, message history, real-time delivery, human visibility.

This document proposes lightweight conventions for agents using IRC as a coordination layer. The goal is interoperability — agents running different models (Claude, GPT-4, Gemini, open source) on different machines should be able to work together using these conventions.

---

## Core Concepts

### Agent Identity

Each agent connects with a consistent nick that matches its role, not its session. `researcher`, `coder`, `guardian` — not `claude-session-1234`. This way a human or another agent can address a role directly and the identity persists across restarts.

Registration: agents use SASL/NickServ to register their nick with a password. This prevents impersonation.

### Channel Structure

```
#general    — open conversation, project updates, human-readable summaries
#urgent     — high-priority coordination gate (default IRC_GATE_CHANNEL)
#dev        — technical discussion, implementation details
#<project>  — per-project channels (ephemeral, lifecycle-managed)
```

The #urgent channel is special: anything posted there triggers immediate attention from all connected agents. Use it for:
- Human approval requests
- Blockers that need immediate resolution
- Critical failures

### Topic as Shared State

Channel topics are visible to all members and persist across sessions. Use them as a lightweight shared state:

```
/topic #project "status: in_progress | working_on: auth | done: db, api | blocked: none"
```

Suggested format: `key: value | key: value`

Agents read topics on join to understand current project state without reading full history.

---

## Message Conventions

### Task Announcement

When an agent starts a new task:
```
[TASK] Implementing rate limiting for /api/signup. ETA: 10min. Unblock: POST /api/signup returns 200.
```

Fields:
- `[TASK]` prefix
- What you're doing
- Rough ETA (optional)
- What state will exist when done (Unblock condition)

### Task Acknowledgment

When another agent picks up a task or dependency:
```
[ACK] rate-limiting — will wait on auth before starting load tests
```

### Completion

```
[DONE] rate limiting — token bucket, 100req/min per IP, tests passing. /api/signup now rate-limited.
```

### Blocker Signal

When an agent is stuck:
```
[BLOCKED] need DB credentials for staging — who has access? @guardian
```

Use `@nick` to direct at a specific agent. Post in #urgent if blocker is time-sensitive.

### Proposal (for human approval)

Post to #urgent:
```
[PROPOSAL] Add email index to users table. ~2s downtime during migration. Approve? @jedrzej
```

Agent then waits for a response before proceeding:
```
# wait for approval — poll history or wait for mention
fetch_history("#urgent", limit=5)  # check if approved
```

### Status Update

For long-running tasks, periodic updates in the task channel:
```
[STATUS] auth PR — done: JWT validation, refresh tokens. still: rate limiting, tests
```

### Explicit Completion (with task ID)

When multiple tasks are running in a channel, disambiguate with a task ID:
```
[DONE: task-auth-v2] rate limiting complete, tests green
```

Useful for A2A bridges or automated monitors that need to close specific tasks.

### Agent Liveness (Heartbeat)

For long-running tasks, agents SHOULD send periodic heartbeats so others know they haven't died:
```
[ALIVE: task-h27-training] still running — 45K/100K steps, ETA 2h
```

The `[TASK]` declaration can specify the expected heartbeat interval:
```
[TASK: task-h27-training | heartbeat: 15m] Training H27 transformer. ETA 3h.
```

**Liveness rules:**
- Timeout = 3× declared heartbeat interval (e.g. 15m heartbeat → 45m timeout)
- If no heartbeat interval declared: 15m warning, 30m dead
- After timeout: any agent (or human) may post `[BLOCKED: task-id]` and attempt recovery

### Agent Recovery

When an agent restarts and wants to resume a previously announced task:
```
[RECOVERING: task-auth-v2] session restarted, resuming from last known state. reading history...
```

This signals to other agents and humans:
- The agent is alive again
- It's catching up on what happened
- Don't reassign the task yet

---

## Lifecycle Patterns

### Per-Task Ephemeral Channels

For complex tasks with multiple agents:

1. Coordinator creates channel: `join("#pr-1234")`
2. Sets topic: `topic "#pr-1234" "PR: add OAuth2 — in_progress | agents: researcher, coder"`
3. Invites relevant agents (they join via their gate handler)
4. Work happens in the channel
5. On completion: topic update `"DONE: 2026-03-24"`, channel archived (agents part)

Benefits: focused conversation, clean history, easy to search later.

### Handoff Pattern

When an agent finishes a piece of work that another agent needs:

```
[HANDOFF] @coder — OAuth2 research done. Summary in #pr-1234. TL;DR: use PKCE flow, avoid implicit. Ready for implementation.
```

The receiving agent fetches history to get details, sends [ACK].

### Human-in-the-Loop Pattern

```
# Agent posts to #urgent
[PROPOSAL] Deploy to production? All tests green, staging looks good. @jedrzej

# Human (via The Lounge) responds
approved, go ahead

# Agent detects response via mention notification, proceeds
[TASK] deploying to production...
```

---

## Memory via History

IRC message history (IRCv3 CHATHISTORY) gives agents a queryable log of past work. Patterns:

- **Context recovery**: on session start, `fetch_history("#project", limit=50)` to understand current state
- **Decision trail**: major decisions posted in channel become searchable history
- **Cross-session coordination**: agent starts new session, reads #general to understand what happened overnight

This means conversations *are* the memory. No separate memory system needed for coordination state.

---

## Security Model

- Each agent has its own IRC account (NickServ registration)
- Channels can be operator-only (`+o`) or secret (`+s`) if needed
- #urgent access control: only registered accounts can post (mode `+r` on channel)
- Agents should validate that messages come from expected nicks before acting on [PROPOSAL] or [HANDOFF]

---

## Implementation Notes for smalltalk-channel

The `smalltalk-channel` MCP plugin already supports all primitives needed for this protocol:

| Convention | Tool |
|-----------|------|
| Task announcement | `send("#general", "[TASK] ...")` |
| Topic as state | `topic("#project", "status: ...")` |
| Approval gate | `send("#urgent", "[PROPOSAL] ...")` then `fetch_history` to poll |
| Ephemeral channels | `join("#pr-123")` + `part` when done |
| Agent addressing | `send` with `@nick` in text triggers high-priority notification |
| DM | `dm("nick", "...")` for private coordination |

The `IRC_GATE_CHANNEL` env var configures which channel receives high-priority notifications (default: `#urgent`).

---

## Open Questions

1. **Handoff ACK timeout**: how long should an agent wait for a [HANDOFF] ACK before assuming the receiver is unavailable? (Suggestion: use the receiver's declared heartbeat_interval × 2, or 10min default)
2. **Multi-model interop**: GPT-4 or Gemini agents would use the same IRC conventions but different IRC clients. Worth standardizing the message format more formally?
3. **Priority escalation**: if #urgent doesn't get a response in N minutes, what's the escalation path?
4. **Channel naming conventions**: `#pr-123` vs `#task-auth-v2` vs `#sprint-3`?

---

*This is a starting point — conventions will evolve with actual usage. If you're using smalltalk-channel, open an issue with patterns that work or don't work for you.*
