# Setup Guide

A short path from fresh clone to working Spectacles + OpenClaw.

## What you need

- OpenClaw running locally with gateway access enabled
- a valid OpenClaw gateway token
- Node.js 18+
- `cloudflared`
- Lens Studio + Spectacles

## 1. Clone the repo

```bash
git clone https://github.com/davidezhang/openclaw-spectacles.git
cd openclaw-spectacles
```

## 2. Configure the local proxy

The proxy is `bridge/proxy.js`.

Required env var:

```bash
export OPENCLAW_GATEWAY_TOKEN=your-token-here
```

Optional env vars:

```bash
export OPENCLAW_GATEWAY_HOST=127.0.0.1
export OPENCLAW_GATEWAY_PORT=18789
export PROXY_PORT=3210
export SPECTACLES_IMAGE_DIR="$HOME/.openclaw/workspace/tmp/spectacles-captures"
export SPECTACLES_PROXY_LOG_FILE="$HOME/.openclaw/spectacles-proxy.log"
```

You can use `bridge/.env.example` as a reference for these values.

## 3. Start the proxy

```bash
node bridge/proxy.js
```

Expected startup log:

```text
Spectacles auth proxy on :3210 -> gateway :18789
```

## 4. Start the tunnel

In another terminal:

```bash
cloudflared tunnel --url http://localhost:3210
```

Copy the HTTPS tunnel URL that Cloudflare prints.

## 5. Point the Lens at your tunnel

Create your local Lens config from the example file:

- copy `lens-project/Spectacles_OpenClaw/Assets/Scripts/LocalConfig.example.ts`
- to `lens-project/Spectacles_OpenClaw/Assets/Scripts/LocalConfig.ts`

Then set:

- `endpoint` to `https://your-tunnel.example.com/v1/chat/completions`
- optional `sessionKey` if you want a specific OpenClaw session

`LocalConfig.ts` is git-ignored so your local values stay private.

## 6. Optional: install as a background service

### macOS

```bash
OPENCLAW_GATEWAY_TOKEN=your-token-here bash bridge/install-macos.sh
```

This writes a real launchd plist under:

- `~/Library/LaunchAgents/com.openclaw.spectacles-proxy.plist`

The checked-in file:

- `bridge/com.openclaw.spectacles-proxy.plist.template`

is only a public template.

### Linux

```bash
OPENCLAW_GATEWAY_TOKEN=your-token-here bash bridge/install-linux.sh
```

This writes a real user service under:

- `~/.config/systemd/user/openclaw-spectacles-proxy.service`

## Security notes

Safe to commit:

- `bridge/proxy.js`
- `bridge/.env.example`
- `bridge/com.openclaw.spectacles-proxy.plist.template`
- docs and Lens project files with placeholder values

Do not commit:

- real gateway tokens
- generated launchd/systemd service files containing your token
- private tunnel URLs
- personal session keys

## Troubleshooting

- `status: 3` usually means the lens request was blocked before dispatch; do not send `Authorization` from Lens Studio
- `401` usually means your gateway token is wrong or missing
- `502` usually means the proxy cannot reach the OpenClaw gateway

For more detail, see `docs/troubleshooting.md`.
