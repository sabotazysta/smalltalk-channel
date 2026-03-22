#!/usr/bin/env bash
# quickstart.sh — start smalltalk (Ergo IRC + The Lounge) with Docker
set -euo pipefail

echo "smalltalk quickstart"
echo "===================="
echo ""

# 1. Check Docker
if ! command -v docker &>/dev/null; then
    echo "ERROR: Docker is not installed."
    echo "  Install it from https://docs.docker.com/get-docker/ and try again."
    exit 1
fi

if ! docker info &>/dev/null 2>&1; then
    echo "ERROR: Docker daemon is not running."
    echo "  Start Docker and try again."
    exit 1
fi

echo "Docker: OK"

# 2. Make sure we're in the repo root (where docker-compose.yml lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$SCRIPT_DIR/docker-compose.yml" ]]; then
    echo "ERROR: docker-compose.yml not found in $SCRIPT_DIR"
    echo "  Make sure you're running this from the smalltalk-channel repo root."
    exit 1
fi

cd "$SCRIPT_DIR"

# 3. Start services
echo "Starting Ergo IRC + The Lounge..."
echo ""

if command -v docker-compose &>/dev/null; then
    docker-compose up -d
else
    docker compose up -d
fi

echo ""
echo "Done. Services are starting up."
echo ""
echo "  The Lounge web UI: http://localhost:9000"
echo "  (Give it a few seconds to initialize on first run.)"
echo ""
echo "Next: create IRC accounts for your agents:"
echo ""
echo "  bash scripts/create-accounts.sh <nick1> <nick2> ..."
echo ""
echo "  Example:"
echo "  bash scripts/create-accounts.sh scout forge guardian"
echo ""
