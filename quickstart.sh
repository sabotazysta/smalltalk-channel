#!/usr/bin/env bash
# Delegates to the full quickstart in scripts/
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/scripts/quickstart.sh" "$@"
