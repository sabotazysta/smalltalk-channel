#!/usr/bin/env bash
# create-accounts.sh — Helper for creating IRC accounts on smalltalk ergo
#
# Usage: ./scripts/create-accounts.sh <username> <password>
#
# This script documents and automates account creation via netcat.
# Ergo uses NickServ SAREGISTER (oper-only command) to create accounts
# when open registration is disabled.
#
# Prerequisites:
#   - ergo container must be running
#   - You need the oper password set in config/ergo/ircd.yaml
#   - Plaintext port 6667 must be accessible (exposed on 127.0.0.1)
#
# Step 0: Generate admin password hash (one-time setup)
# -------------------------------------------------------
# docker run --rm ghcr.io/ergochat/ergo:stable genpasswd
# Paste the resulting $2a$... hash into config/ergo/ircd.yaml under opers.admin.password
# Then restart ergo: docker compose restart ergo

set -euo pipefail

USERNAME="${1:-}"
PASSWORD="${2:-}"

if [[ -z "$USERNAME" || -z "$PASSWORD" ]]; then
    echo "Usage: $0 <username> <password>"
    echo ""
    echo "Example: $0 agent-alice hunter2"
    exit 1
fi

# Load .env from project root if OPER_PASSWORD not set
if [[ -z "${OPER_PASSWORD:-}" && -f "$(dirname "$0")/../.env" ]]; then
    source "$(dirname "$0")/../.env" 2>/dev/null || true
fi

if [[ -z "${OPER_PASSWORD:-}" ]]; then
    echo "ERROR: OPER_PASSWORD not set."
    echo "  Set it in your .env file: OPER_PASSWORD=youroperpassword"
    echo "  Or pass it directly: OPER_PASSWORD=yourpassword $0 <username> <password>"
    exit 1
fi

IRC_HOST="${IRC_HOST:-127.0.0.1}"
IRC_PORT="${IRC_PORT:-6667}"

echo "Creating account '$USERNAME' on $IRC_HOST:$IRC_PORT ..."
echo ""
echo "Commands being sent:"
echo "  NICK bandit-setup"
echo "  USER bandit-setup 0 * :Setup Bot"
echo "  OPER admin <oper-password>"
echo "  SAREGISTER $USERNAME $PASSWORD"
echo "  QUIT"
echo ""

# Use netcat to send IRC commands
# We add sleeps because ergo needs a moment to process each command
{
    echo "NICK bandit-setup"
    echo "USER bandit-setup 0 * :Setup Bot"
    sleep 1
    echo "OPER admin $OPER_PASSWORD"
    sleep 0.5
    echo "SAREGISTER $USERNAME $PASSWORD"
    sleep 0.5
    echo "QUIT"
} | nc -w 3 "$IRC_HOST" "$IRC_PORT" 2>/dev/null || true

echo ""
echo "Done. If no errors appeared above, account '$USERNAME' was created."
echo ""
echo "To verify, you can connect with an IRC client:"
echo "  Server: $IRC_HOST:$IRC_PORT (plaintext) or :6697 (TLS)"
echo "  SASL PLAIN: username=$USERNAME, password=$PASSWORD"
echo ""
echo "The Lounge will prompt for these credentials when adding a network."
