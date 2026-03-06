#!/usr/bin/env bash
# bridge/install-macos.sh
#
# Installs the openclaw-spectacles auth proxy as a macOS launchd user service.
# The service starts automatically at login and restarts if it crashes.
#
# Usage:
#   OPENCLAW_GATEWAY_TOKEN=your-token bash bridge/install-macos.sh
#
# Or run interactively — the script will prompt for the token.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_LABEL="com.openclaw.spectacles-proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
TEMPLATE_PATH="${SCRIPT_DIR}/${PLIST_LABEL}.plist.template"
PROXY_SCRIPT="${SCRIPT_DIR}/proxy.js"
NODE_BIN="$(command -v node || true)"

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found in PATH. Install Node.js 18+ and try again."
  exit 1
fi

if [[ ! -f "$PROXY_SCRIPT" ]]; then
  echo "ERROR: Cannot find proxy.js at $PROXY_SCRIPT"
  exit 1
fi

if [[ ! -f "$TEMPLATE_PATH" ]]; then
  echo "ERROR: Cannot find plist template at $TEMPLATE_PATH"
  exit 1
fi

# ---------------------------------------------------------------------------
# Token
# ---------------------------------------------------------------------------

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  read -rsp "Enter your OpenClaw gateway token: " OPENCLAW_GATEWAY_TOKEN
  echo
fi

if [[ -z "$OPENCLAW_GATEWAY_TOKEN" ]]; then
  echo "ERROR: No token provided. Aborting."
  exit 1
fi

GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
PROXY_PORT="${PROXY_PORT:-3210}"

# ---------------------------------------------------------------------------
# Build plist from template
# ---------------------------------------------------------------------------

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs"

sed \
  -e "s|{{NODE_BIN}}|${NODE_BIN}|g" \
  -e "s|{{PROXY_SCRIPT}}|${PROXY_SCRIPT}|g" \
  -e "s|{{OPENCLAW_GATEWAY_TOKEN}}|${OPENCLAW_GATEWAY_TOKEN}|g" \
  -e "s|{{OPENCLAW_GATEWAY_PORT}}|${GATEWAY_PORT}|g" \
  -e "s|{{PROXY_PORT}}|${PROXY_PORT}|g" \
  "$TEMPLATE_PATH" > "$PLIST_PATH"

echo "Wrote plist to $PLIST_PATH"

# ---------------------------------------------------------------------------
# Load (or reload) the service
# ---------------------------------------------------------------------------

if launchctl list | grep -q "$PLIST_LABEL"; then
  echo "Service already loaded — reloading..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

launchctl load "$PLIST_PATH"
echo "Service loaded."

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

sleep 1

if launchctl list | grep -q "$PLIST_LABEL"; then
  echo "SUCCESS: ${PLIST_LABEL} is running."
  echo
  echo "Logs:"
  echo "  stdout: $HOME/Library/Logs/openclaw-spectacles-proxy.log"
  echo "  stderr: $HOME/Library/Logs/openclaw-spectacles-proxy.error.log"
  echo
  echo "To stop:    launchctl unload $PLIST_PATH"
  echo "To restart: launchctl unload $PLIST_PATH && launchctl load $PLIST_PATH"
else
  echo "WARNING: Service does not appear to be running."
  echo "Check: $HOME/Library/Logs/openclaw-spectacles-proxy.error.log"
  exit 1
fi
