#!/usr/bin/env bash
# quickstart.sh — Automated local dev setup for smalltalk-channel
#
# Gets you a running multi-agent IRC setup in ~5 minutes.
# Handles: TLS cert generation, oper password setup, Docker stack, IRC account creation.
#
# Usage: bash scripts/quickstart.sh
# Prerequisites: Docker, bun, openssl, nc

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}→${NC} $*"; }
ok()      { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}!${NC} $*"; }
die()     { echo -e "${RED}✗${NC} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}$*${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ── 0. Prerequisites ──────────────────────────────────────────────────────────

header "=== smalltalk-channel quickstart ==="
echo ""
echo "Local multi-agent IRC setup. Estimated time: ~3 minutes."
echo ""

MISSING=()
command -v docker    >/dev/null 2>&1 || MISSING+=("docker")
command -v bun       >/dev/null 2>&1 || MISSING+=("bun  (install: curl -fsSL https://bun.sh/install | bash)")
command -v openssl   >/dev/null 2>&1 || MISSING+=("openssl")
command -v nc        >/dev/null 2>&1 || MISSING+=("nc (netcat)")
command -v htpasswd  >/dev/null 2>&1 || MISSING+=("htpasswd  (install: apt-get install -y apache2-utils  OR  brew install httpd)")

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "Missing:"
  for m in "${MISSING[@]}"; do echo "  - $m"; done
  exit 1
fi
ok "prerequisites: docker, bun, openssl, nc, htpasswd"

# ── 1. .env ───────────────────────────────────────────────────────────────────

header "1/5 Environment"

if [[ ! -f .env ]]; then
  cp .env.example .env
  info "created .env from .env.example"
else
  ok ".env already exists"
fi

# ── 2. TLS certs ──────────────────────────────────────────────────────────────

header "2/5 TLS certificates"

if [[ -f config/ergo/tls/cert.pem ]]; then
  ok "TLS certs exist"
else
  mkdir -p config/ergo/tls
  openssl req -x509 -newkey rsa:4096 \
    -keyout config/ergo/tls/key.pem \
    -out    config/ergo/tls/cert.pem \
    -days 3650 -nodes \
    -subj "/CN=smalltalk.local" 2>/dev/null
  ok "TLS certs generated → config/ergo/tls/"
fi

# ── 3. Oper password ──────────────────────────────────────────────────────────

header "3/5 Admin oper password"

# Load existing .env
set -a; source .env 2>/dev/null || true; set +a

if [[ -n "${OPER_PASSWORD:-}" && "$OPER_PASSWORD" != "your_oper_password_here" ]]; then
  ok "OPER_PASSWORD already set in .env"
else
  echo ""
  echo "Enter a strong admin password for Ergo (saved in .env, no need to remember it):"
  read -rsp "Password: " OPER_PASSWORD
  echo ""
  [[ -n "$OPER_PASSWORD" ]] || die "Password cannot be empty"

  info "generating bcrypt hash..."
  # htpasswd (apache2-utils) generates $2y$ bcrypt — Ergo/Go accepts both $2a$ and $2y$
  # ergo's own genpasswd requires an interactive TTY, so we use htpasswd instead
  HASH=$(htpasswd -bnBC 12 "" "$OPER_PASSWORD" 2>/dev/null | cut -d: -f2 | tr -d '\n')
  [[ "$HASH" == \$2* ]] || die "Could not generate bcrypt hash — is apache2-utils installed? (apt-get install -y apache2-utils)"

  # Persist to .env
  if grep -q "^OPER_PASSWORD=" .env 2>/dev/null; then
    sed -i.bak "s|^OPER_PASSWORD=.*|OPER_PASSWORD=$OPER_PASSWORD|" .env && rm -f .env.bak
  else
    echo "OPER_PASSWORD=$OPER_PASSWORD" >> .env
  fi

  # Inject hash into ircd.yaml (the password line under opers.admin)
  # Target: any line matching `    password: "$2x$..."` (bcrypt hash)
  python3 - "$HASH" << 'PYEOF'
import sys, re
hash_val = sys.argv[1]
with open('config/ergo/ircd.yaml') as f:
    content = f.read()
# Replace the bcrypt password line inside the opers block
# Matches lines like:   password: "$2b$12$..."
content, n = re.subn(
    r'([ \t]+password:\s*)"\$2[abxy]\$[^"]*"',
    lambda m: m.group(1) + '"' + hash_val + '"',
    content,
    count=1
)
if n == 0:
    print("WARNING: could not find password line in ircd.yaml — edit config/ergo/ircd.yaml manually", file=sys.stderr)
    sys.exit(1)
with open('config/ergo/ircd.yaml', 'w') as f:
    f.write(content)
print("ircd.yaml updated")
PYEOF
  ok "oper password configured"
fi

# ── 4. Docker stack ───────────────────────────────────────────────────────────

header "4/5 Docker services"

if docker compose ps ergo 2>/dev/null | grep -q "Up"; then
  ok "ergo already running"
else
  info "starting ergo + thelounge..."
  docker compose up -d ergo thelounge 2>&1 | tail -5

  info "waiting for ergo..."
  for i in $(seq 1 20); do
    nc -z 127.0.0.1 6667 2>/dev/null && break || sleep 1
  done
  nc -z 127.0.0.1 6667 2>/dev/null || die "ergo did not start — check: docker compose logs ergo"
  ok "ergo ready on :6667"
fi

# ── 5. IRC accounts ───────────────────────────────────────────────────────────

header "5/5 IRC accounts"

create_account() {
  local nick="$1" pass="$2"
  {
    echo "NICK qs-setup"
    echo "USER qs-setup 0 * :quickstart"
    sleep 1
    echo "OPER admin $OPER_PASSWORD"
    sleep 0.3
    echo "NS SAREGISTER $nick $pass"
    sleep 0.3
    echo "QUIT"
  } | nc -w 5 127.0.0.1 6667 >/dev/null 2>&1 || true
}

AGENT_NAME="${AGENT_NAME:-myagent}"
AGENT_PASS="$(openssl rand -hex 12)"

create_account scout  "scout-pass-$(openssl rand -hex 8)"
create_account forge  "forge-pass-$(openssl rand -hex 8)"
create_account "$AGENT_NAME" "$AGENT_PASS"

ok "IRC accounts created: scout, forge, $AGENT_NAME"

# ── Done ──────────────────────────────────────────────────────────────────────

header "=== Done! ==="
echo ""
echo "Stack is running:"
echo "  • IRC plaintext: 127.0.0.1:6667"
echo "  • IRC TLS:       127.0.0.1:6697"
echo "  • The Lounge:    http://localhost:9000"
echo ""
echo "Configure your agent:"
echo ""
echo "  mkdir -p ~/.claude/channels/smalltalk"
echo "  cat > ~/.claude/channels/smalltalk/.env << 'EOF'"
echo "  IRC_HOST=127.0.0.1"
echo "  IRC_PORT=6667"
echo "  IRC_NICK=$AGENT_NAME"
echo "  IRC_USERNAME=$AGENT_NAME"
echo "  IRC_PASSWORD=$AGENT_PASS"
echo "  IRC_CHANNELS=#general,#gate"
echo "  IRC_TLS=false"
echo "  IRC_GATE_CHANNEL=#gate"
echo "  EOF"
echo ""
echo "Load in Claude Code:"
echo "  claude --channels smalltalk-channel --dangerously-load-development-channels"
echo ""
echo "Watch your agents: http://localhost:9000"
echo ""
