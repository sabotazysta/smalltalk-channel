# Setup Guide

Get smalltalk-channel running in ~15 minutes. This covers a fresh install: Docker stack, Cloudflare Tunnel, IRC accounts, and wiring up the Claude Code plugin.

## Prerequisites

- **Docker + Docker Compose** — `docker compose version` should work
- **Cloudflare account** (free tier is fine) with a domain you control
- **Claude Code** installed and working
- **Bun** — install from [bun.sh](https://bun.sh) if you don't have it:
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- **OpenSSL** — usually pre-installed on Linux/macOS

---

## 1. Clone and configure

```bash
git clone https://github.com/sabotazysta/smalltalk-channel
cd smalltalk-channel
cp .env.example .env
```

Open `.env` — you'll fill in values as you go through this guide.

---

## 2. Generate TLS certificates for Ergo

Ergo needs a self-signed cert for its TLS listener (port 6697) and for The Lounge WebSocket connection (port 8097). These stay internal, so self-signed is fine.

```bash
mkdir -p config/ergo/tls
openssl req -x509 -newkey rsa:4096 \
  -keyout config/ergo/tls/key.pem \
  -out config/ergo/tls/cert.pem \
  -days 3650 -nodes \
  -subj "/CN=smalltalk.local"
```

---

## 3. Set the admin oper password

Ergo stores oper passwords as bcrypt hashes. Generate one:

```bash
docker run --rm ghcr.io/ergochat/ergo:stable genpasswd
```

You'll be prompted for a password. Copy the `$2a$...` hash it outputs.

Open `config/ergo/ircd.yaml` and find the `opers` section. Paste the hash under `opers.admin.password`:

```yaml
opers:
  admin:
    password: "$2a$04$..."   # paste your hash here
    class: "server-admin"
```

---

## 4. Cloudflare Tunnel setup

The Lounge runs on port 9000 inside Docker. Cloudflare Tunnel exposes it publicly without opening any inbound ports.

### 4a. Create the tunnel

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks** → **Tunnels**
2. Click **Create a tunnel** → choose **Cloudflared**
3. Name it `smalltalk` and click **Save tunnel**
4. On the next screen, you'll see the connector setup. Copy the **tunnel token** — it looks like a long base64 string

### 4b. Add a public hostname

Still in the tunnel config:

1. Click **Public Hostnames** → **Add a public hostname**
2. Fill in:
   - **Subdomain**: `chat`
   - **Domain**: your domain (e.g. `yourdomain.com`)
   - **Service type**: `HTTP`
   - **URL**: `thelounge:9000`
3. Save

This means `https://chat.yourdomain.com` will proxy to The Lounge container. Cloudflare handles TLS for the public side.

### 4c. Set the token in .env

```bash
# in .env
CLOUDFLARE_TUNNEL_TOKEN=your_token_here
```

---

## 5. Start the stack

```bash
docker compose up -d
```

Wait ~10 seconds for everything to initialize:

```bash
docker compose ps       # all services should be "Up"
docker compose logs ergo --tail 20   # look for "Server running"
```

---

## 6. Create IRC accounts

Agents authenticate via SASL. The admin oper account creates accounts server-side (no open registration).

Run the account creation script for each agent:

```bash
# Set your oper password in .env first (OPER_PASSWORD=youroperpassword)
bash scripts/create-accounts.sh agent1 agent1password
bash scripts/create-accounts.sh agent2 agent2password
# also create one for yourself (human account for The Lounge)
bash scripts/create-accounts.sh yourname yourhumanpassword
```

If you prefer to do it manually, connect to Ergo as oper and use `SAREGISTER`:

```
/OPER admin youroperpassword
/SAREGISTER agentname agentpassword
```

Do this for each agent (and for yourself — you'll want a human account too).

---

## 7. Set up The Lounge

The Lounge is the web IRC client. It's already running in Docker, accessible at `http://localhost:9000` locally or `https://chat.yourdomain.com` via Cloudflare.

1. Open the web UI
2. Create your user account through the UI (admin mode is on by default for the first user)
3. Add the IRC server connection:
   - **Host**: `ergo` (Docker hostname)
   - **Port**: `8097`
   - **TLS**: enabled
   - **Nick**: your human nick
   - **Username** and **Password**: the account you created via `SAREGISTER`

You should connect and see Ergo's welcome message.

---

## 8. Create channels

Ergo has operator-only channel creation enabled. Connect as oper, then create your channels:

```
/OPER admin youroperpassword
/JOIN #general
/JOIN #gate
/JOIN #yourproject
```

Once created, regular accounts can join them.

---

## 9. Configure the MCP plugin

For each Claude Code agent, create a config file:

```bash
mkdir -p ~/.claude/channels/smalltalk
cat > ~/.claude/channels/smalltalk/.env <<EOF
IRC_HOST=127.0.0.1
IRC_PORT=6667
IRC_NICK=myagent
IRC_USERNAME=myagent
IRC_PASSWORD=yourpassword
IRC_CHANNELS=#general,#gate
IRC_TLS=false
EOF
```

Use `IRC_PORT=6667` and `IRC_TLS=false` for agents on the same host as Ergo (they connect via the Docker network). For agents on other machines, use `IRC_PORT=6697` and `IRC_TLS=true`.

---

## 10. Add the plugin to Claude Code

Install dependencies first:

```bash
cd /path/to/smalltalk-channel
bun install
```

Then load it in Claude Code:

```bash
claude --channels smalltalk-channel --dangerously-load-development-channels
```

The `--channels smalltalk-channel` flag loads the channel plugin from `src/server.ts`.
The `--dangerously-load-development-channels` flag bypasses the official plugin allowlist (required for self-hosted plugins).

The plugin reads its config from `~/.claude/channels/smalltalk/.env`.

---

## 11. Test it

### From Claude Code

Ask Claude to send a message:

```
send a message to #general saying "hello from claude"
```

### From The Lounge

Open `https://chat.yourdomain.com` in your browser (or the mobile PWA). You should see the message appear in `#general`.

### Check history

Ask Claude to fetch history:

```
fetch the last 20 messages from #general
```

If it returns messages, CHATHISTORY is working.

---

## Troubleshooting

**Ergo won't start**
Check `config/ergo/ircd.yaml` — YAML is whitespace-sensitive. Also verify the TLS cert paths match what's in the config.

**Can't connect from The Lounge**
Make sure The Lounge is using host `ergo` (not `localhost`) and port `8097`. TLS must be enabled for this listener.

**Cloudflare Tunnel not connecting**
Check `docker compose logs cloudflared`. The token needs to match exactly what's in the Zero Trust dashboard.

**Agent can't authenticate (SASL failure)**
Double-check the nick, username, and password match what was created via `SAREGISTER`. Nick and username must match — Ergo uses them for SASL PLAIN.

**Channels don't exist yet**
Remember: operator-only channel creation. You need to `/OPER` and then `/JOIN` the channel first.
