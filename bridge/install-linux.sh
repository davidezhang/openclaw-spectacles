#!/usr/bin/env bash
# bridge/install-linux.sh
#
# Installs the openclaw-spectacles auth proxy as a systemd user service.
# The service starts automatically at login (or on boot with lingering enabled)
# and restarts if it crashes.
#
# Usage:
#   OPENCLAW_GATEWAY_TOKEN=your-token bash bridge/install-linux.sh
#
# Or run interactively — the script will prompt for the token.
#
# Requirements: systemd (user session), Node.js 18+

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="openclaw-spectacles-proxy"
SERVICE_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
PROXY_SCRIPT="${SCRIPT_DIR}/proxy.js"
NODE_BIN="$(command -v node || true)"

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found in PATH. Install Node.js 18+ and try again."
  exit 1
fi

if ! command -v systemctl &>/dev/null; then
  echo "ERROR: systemctl not found. This script requires systemd."
  exit 1
fi

if [[ ! -f "$PROXY_SCRIPT" ]]; then
  echo "ERROR: Cannot find proxy.js at $PROXY_SCRIPT"
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
# Write systemd unit file
# ---------------------------------------------------------------------------

mkdir -p "$(dirname "$SERVICE_FILE")"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=OpenClaw Spectacles Auth Proxy
After=network.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${PROXY_SCRIPT}
Restart=on-failure
RestartSec=5

Environment="OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}"
Environment="OPENCLAW_GATEWAY_PORT=${GATEWAY_PORT}"
Environment="PROXY_PORT=${PROXY_PORT}"

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

echo "Wrote service file to $SERVICE_FILE"

# ---------------------------------------------------------------------------
# Enable and start
# ---------------------------------------------------------------------------

systemctl --user daemon-reload
systemctl --user enable "${SERVICE_NAME}"
systemctl --user restart "${SERVICE_NAME}"

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

sleep 1

if systemctl --user is-active --quiet "${SERVICE_NAME}"; then
  echo "SUCCESS: ${SERVICE_NAME} is running."
  echo
  echo "Useful commands:"
  echo "  Status:   systemctl --user status ${SERVICE_NAME}"
  echo "  Logs:     journalctl --user -u ${SERVICE_NAME} -f"
  echo "  Stop:     systemctl --user stop ${SERVICE_NAME}"
  echo "  Disable:  systemctl --user disable ${SERVICE_NAME}"
  echo
  echo "To survive after logout, enable lingering:"
  echo "  loginctl enable-linger \$USER"
else
  echo "WARNING: Service does not appear to be running."
  echo "Check: journalctl --user -u ${SERVICE_NAME} -xe"
  exit 1
fi
