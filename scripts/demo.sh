#!/usr/bin/env bash
# smalltalk-channel demo — shows two agents coordinating via IRC
#
# Usage: ./scripts/demo.sh
# Requires: stack running (docker compose up -d), bun in PATH

set -euo pipefail

export PATH="/home/bandit/.bun/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../src"

echo "=== smalltalk-channel demo ==="
echo ""
echo "This demo shows two agents (scout + forge) coordinating via IRC."
echo "Scout discovers a task, forge implements it, they sync via #general."
echo ""

# Check stack is running
if ! nc -z 127.0.0.1 6667 2>/dev/null; then
    echo "ERROR: Ergo IRC not running. Start with: docker compose up -d"
    exit 1
fi

echo "[*] IRC server reachable"
echo ""

# Agent helper — sends MCP messages to a running server instance
send_irc() {
    local nick="$1"
    local channel="$2"
    local message="$3"

    (
        SASL=$(python3 -c "import base64; print(base64.b64encode(b'\\x00${nick}\\x00${nick}-irc-2024!').decode())")
        printf "CAP LS 302\nNICK ${nick}\nUSER ${nick} 0 * :${nick} agent\nCAP REQ :sasl\n"
        sleep 0.3
        printf "AUTHENTICATE PLAIN\n"
        sleep 0.2
        printf "AUTHENTICATE ${SASL}\n"
        sleep 0.2
        printf "CAP END\n"
        sleep 1
        printf "JOIN ${channel}\n"
        sleep 0.5
        printf "PRIVMSG ${channel} :${message}\n"
        sleep 0.5
        printf "QUIT\n"
    ) | nc -w 5 127.0.0.1 6667 2>/dev/null | grep -E "^:.*PRIVMSG|001" | grep -v "NickServ" | head -3 || true
}

fetch_history() {
    local channel="$1"
    (
        SASL=$(python3 -c "import base64; print(base64.b64encode(b'\\x00bandit\\x00bandit-irc-2024!').decode())")
        printf "CAP LS 302\nNICK bandit\nUSER bandit 0 * :bandit\nCAP REQ :sasl message-tags batch chathistory\n"
        sleep 0.3
        printf "AUTHENTICATE PLAIN\n"
        sleep 0.2
        printf "AUTHENTICATE ${SASL}\n"
        sleep 0.2
        printf "CAP END\n"
        sleep 1
        printf "JOIN ${channel}\n"
        sleep 0.5
        printf "CHATHISTORY LATEST ${channel} * 20\n"
        sleep 2
        printf "QUIT\n"
    ) | nc -w 8 127.0.0.1 6667 2>/dev/null | grep "PRIVMSG ${channel}" | sed "s/.*PRIVMSG ${channel} ://g" | head -20 || true
}

echo "[1] Scout agent announces a task..."
send_irc "scout" "#gate" "[TASK] Need to implement rate limiting for /api/signup endpoint. Priority: high."
sleep 1

echo "[2] Forge agent picks it up..."
send_irc "forge" "#gate" "[ACK] On it. Will implement token bucket — ETA 10min."
sleep 1

echo "[3] Forge reports progress to #general..."
send_irc "forge" "#general" "Rate limiter done. Used sliding window (1h), max 3 requests per IP. Added to worker.js."
sleep 1

echo "[4] Scout confirms in #general..."
send_irc "scout" "#general" "Reviewed. Looks good. Deploying."
sleep 1

echo ""
echo "[5] Fetching #general history (what the agents said):"
echo "---"
fetch_history "#general"
echo "---"
echo ""
echo "=== Demo complete ==="
echo ""
echo "The MCP plugin delivers these messages as notifications to each agent's Claude session."
echo "HIGH priority: #gate messages (immediate attention)"
echo "NORMAL priority: #general messages (batched, read when convenient)"
