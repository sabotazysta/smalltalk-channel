#!/usr/bin/env bash
# smalltalk-channel MCP demo — shows actual JSON-RPC tool calls
#
# This demo starts two MCP server instances (scout + forge) and has them
# exchange messages via IRC using the real MCP protocol — exactly as Claude Code
# uses them in production.
#
# Usage: ./scripts/demo-mcp.sh

set -euo pipefail

export PATH="/home/bandit/.bun/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../src"
SERVER="$SRC/server.ts"

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

echo ""
echo -e "${CYAN}=== smalltalk-channel MCP demo ===${RESET}"
echo ""
echo "Two agents (scout + forge) coordinate via IRC using the MCP JSON-RPC protocol."
echo "This is exactly how Claude Code uses the plugin."
echo ""

# Check stack is running
if ! nc -z 127.0.0.1 6667 2>/dev/null; then
    echo "ERROR: Ergo IRC not running. Start with: docker compose up -d"
    exit 1
fi

# ─── MCP client helper ────────────────────────────────────────────────────────
# Sends JSON-RPC messages to an MCP server and captures the response

mcp_call() {
    local nick="$1"
    local tool="$2"
    local args="$3"

    local msg_id=2
    local init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo","version":"1.0"}}}'
    local call="{\"jsonrpc\":\"2.0\",\"id\":${msg_id},\"method\":\"tools/call\",\"params\":{\"name\":\"${tool}\",\"arguments\":${args}}}"

    local result
    result=$(
        IRC_NICK="$nick" IRC_USERNAME="$nick" IRC_PASSWORD="${nick}-irc-2024!" \
        IRC_HOST=127.0.0.1 IRC_PORT=6667 IRC_CHANNELS="#general,#gate" \
        IRC_TLS=false IRC_GATE_CHANNEL="#gate" \
        bun run "$SERVER" <<EOF 2>/dev/null
${init}
${call}
EOF
    )

    # Extract the result from the tool call response (id=2)
    echo "$result" | grep '"id":2' | python3 -c "
import json, sys
for line in sys.stdin:
    try:
        r = json.loads(line)
        text = r.get('result', {}).get('content', [{}])[0].get('text', '')
        print(text)
    except: pass
" 2>/dev/null || echo "(no response)"
}

# ─── Demo flow ────────────────────────────────────────────────────────────────

echo -e "${YELLOW}[scout → #gate]${RESET} Announcing a research task..."
TASK_MSG="[TASK] Research best IRC libraries for Python. Need comparison: irctokens vs pydle vs irc3. Priority: high."
mcp_call "scout" "send" "{\"channel\":\"#gate\",\"text\":\"${TASK_MSG}\"}"
echo -e "  ${GREEN}✓${RESET} scout sent to #gate"
sleep 1

echo ""
echo -e "${YELLOW}[forge → #gate]${RESET} Picking up the task..."
ACK_MSG="[ACK] On it. Will benchmark all three libraries — back in 20."
mcp_call "forge" "send" "{\"channel\":\"#gate\",\"text\":\"${ACK_MSG}\"}"
echo -e "  ${GREEN}✓${RESET} forge acknowledged in #gate"
sleep 1

echo ""
echo -e "${YELLOW}[forge → who]${RESET} Checking who's online..."
mcp_call "forge" "who" '{"channel":"#general"}'
sleep 1

echo ""
echo -e "${YELLOW}[forge → #general]${RESET} Posting results..."
RESULT_MSG="Research complete. Verdict: irctokens wins on simplicity (parse-only, no state), pydle best for bots (full IRC3 support), irc3 for plugin architectures. Recommending irctokens for our use case."
mcp_call "forge" "send" "{\"channel\":\"#general\",\"text\":\"${RESULT_MSG}\"}"
echo -e "  ${GREEN}✓${RESET} forge posted results to #general"
sleep 1

echo ""
echo -e "${YELLOW}[scout → fetch_history]${RESET} Reading what forge found..."
mcp_call "scout" "fetch_history" '{"channel":"#general","limit":5}'
sleep 1

echo ""
echo -e "${YELLOW}[scout → dm forge]${RESET} Sending a direct message..."
mcp_call "scout" "dm" '{"nick":"forge","text":"great work, shipping the irctokens approach"}'
echo -e "  ${GREEN}✓${RESET} scout DM'd forge"
sleep 1

echo ""
echo -e "${CYAN}=== Demo complete ===${RESET}"
echo ""
echo "This is the actual MCP JSON-RPC flow. Each tool call above is a real"
echo "tools/call request to the server, which sends IRC messages and returns results."
echo ""
echo "In production, Claude Code calls these same tools based on context:"
echo "  - HIGH priority notifications (mentions, DMs, #gate) → immediate action"
echo "  - NORMAL notifications (other channels) → batch-read when convenient"
echo "  - fetch_history → catch up on missed messages"
echo ""
