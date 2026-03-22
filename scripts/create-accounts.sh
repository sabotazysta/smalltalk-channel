#!/usr/bin/env bash
# create-accounts.sh — Create IRC accounts for agents on the smalltalk Ergo server
#
# Usage: ./scripts/create-accounts.sh <nick1> [nick2] [nick3] ...
#
# Generates a random password for each agent, creates their IRC account,
# and writes credentials to agent-credentials/<nick>.env
#
# Prerequisites:
#   - ergo container must be running (docker compose up -d)
#   - OPER_PASSWORD set in .env or environment
#   - Plaintext port 6667 accessible on 127.0.0.1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load .env if OPER_PASSWORD not set
if [[ -z "${OPER_PASSWORD:-}" && -f "$PROJECT_ROOT/.env" ]]; then
    source "$PROJECT_ROOT/.env" 2>/dev/null || true
fi

if [[ -z "${OPER_PASSWORD:-}" ]]; then
    echo "ERROR: OPER_PASSWORD not set."
    echo "  Set it in your .env file: OPER_PASSWORD=youroperpassword"
    exit 1
fi

if [[ $# -eq 0 ]]; then
    echo "Usage: $0 <nick1> [nick2] [nick3] ..."
    echo ""
    echo "Example: $0 scout forge guardian"
    exit 1
fi

IRC_HOST="${IRC_HOST:-127.0.0.1}"
IRC_PORT="${IRC_PORT:-6667}"

CREDS_DIR="$PROJECT_ROOT/agent-credentials"
mkdir -p "$CREDS_DIR"

create_account() {
    local NICK="$1"
    local PASS="$2"

    {
        echo "NICK setup-$$"
        echo "USER setup-$$ 0 * :Setup"
        sleep 1
        echo "OPER admin $OPER_PASSWORD"
        sleep 0.5
        echo "NS SAREGISTER $NICK $PASS"
        sleep 0.5
        echo "QUIT"
    } | nc -w 3 "$IRC_HOST" "$IRC_PORT" 2>/dev/null || true
}

gen_password() {
    # Generate a 20-char random password (alphanumeric)
    tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 20
}

echo "Creating IRC accounts on $IRC_HOST:$IRC_PORT"
echo ""

CREATED=()
FAILED=()

for NICK in "$@"; do
    PASS=$(gen_password)
    echo -n "  $NICK ... "

    create_account "$NICK" "$PASS"

    # Write credentials file
    cat > "$CREDS_DIR/$NICK.env" <<EOF
IRC_HOST=$IRC_HOST
IRC_PORT=6667
IRC_TLS=false
IRC_NICK=$NICK
IRC_USERNAME=$NICK
IRC_PASSWORD=$PASS
IRC_CHANNELS=#general
EOF

    echo "✅  (pass: $PASS)"
    CREATED+=("$NICK")
done

echo ""
echo "════════════════════════════════════════"
echo "✅ Created ${#CREATED[@]} account(s)"
echo ""
echo "Credentials written to: agent-credentials/"
echo ""
echo "Load into Claude Code agent via .mcp.json:"
echo ""
echo '  {
    "mcpServers": {
      "smalltalk-channel": {
        "command": "npx",
        "args": ["-y", "smalltalk-channel"],
        "env": {
          "IRC_HOST": "127.0.0.1",
          "IRC_NICK": "<nick>",
          "IRC_PASSWORD": "<password>",
          "IRC_CHANNELS": "#general"
        }
      }
    }
  }'
echo ""
echo "Or source the credentials file in your agent's environment:"
echo "  source agent-credentials/<nick>.env"
echo ""
echo "The Lounge web UI: http://localhost:9000"
