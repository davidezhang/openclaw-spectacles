# openclaw-spectacles

Connect [Snap Spectacles](https://spectacles.com) AR glasses to [OpenClaw](https://openclaw.ai) — an AI assistant platform — using a lightweight local auth proxy and Cloudflare Tunnel.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Snap Spectacles (Lens)                                      │
│                                                              │
│  SpectaclesOpenClaw.ts                                       │
│  POST /v1/chat/completions  (no Auth header)                 │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTPS
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Tunnel                                           │
│  your-tunnel.trycloudflare.com  →  localhost:3210           │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP (local)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Auth Proxy  (bridge/proxy.js)  :3210                        │
│                                                              │
│  Injects:  Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>   │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP (local)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  OpenClaw Gateway  :18789                                    │
└─────────────────────────────────────────────────────────────┘
```

> **Key discovery:** Lens Studio's `InternetModule` silently strips `Authorization` headers before sending requests. The local proxy solves this by injecting the token server-side, keeping your credentials off the device entirely.

## Prerequisites

| Requirement | Notes |
|---|---|
| [OpenClaw](https://openclaw.ai) | Running locally with gateway on port 18789 |
| [Node.js](https://nodejs.org) 18+ | For the auth proxy |
| [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) | Creates the HTTPS tunnel |
| [Lens Studio](https://ar.snap.com/lens-studio) 5.x | For building the Spectacles lens |
| Snap Spectacles | Paired via the Spectacles app |

## Quickstart

### 1. Clone the repo

```bash
git clone https://github.com/davidezhang/openclaw-spectacles.git
cd openclaw-spectacles
```

### 2. Set your gateway token

```bash
export OPENCLAW_GATEWAY_TOKEN=your-token-here
```

### 3. Start the auth proxy

```bash
node bridge/proxy.js
# Auth proxy listening on :3210 → forwarding to :18789
```

### 4. Start the Cloudflare Tunnel

In a second terminal:

```bash
cloudflared tunnel --url http://localhost:3210
# ...
# Your quick Tunnel has been created! Visit it at (it may take some time to start up):
# https://some-random-name.trycloudflare.com
```

Copy the `https://...trycloudflare.com` URL.

### 5. Install as a background service (optional)

**macOS:**
```bash
OPENCLAW_GATEWAY_TOKEN=your-token-here bash bridge/install-macos.sh
```

**Linux:**
```bash
OPENCLAW_GATEWAY_TOKEN=your-token-here bash bridge/install-linux.sh
```

### 6. Wire up the Lens

1. Open Lens Studio and create a new project (or open an existing one).
2. Copy `lens/SpectaclesOpenClaw.ts` into your lens project's `Scripts/` folder.
3. Add the script as a component on a Scene Object.
4. In the Inspector, set:
   - **Endpoint** → `https://...trycloudflare.com/v1/chat/completions`
   - **Reply Text** → a Text component in your scene
   - **Test Message** → whatever you want to ask
5. Push the lens to your Spectacles via Lens Studio.

See [`lens/README.md`](lens/README.md) for detailed wiring instructions.

## How It Works

The lens uses **pinch-to-talk**: hold a pinch gesture to start recording speech, release to send. On-device speech-to-text (ASR) transcribes your voice locally on the Spectacles — no audio is sent to any server.

1. You pinch and hold — the lens starts listening via `AsrModule` and shows your transcribed speech in real time.
2. You release the pinch — the lens stops recording, takes the final transcript, and POSTs `{"messages":[{"role":"user","content":"..."}]}` to `<endpoint>/v1/chat/completions`.
3. The request travels over HTTPS through the Cloudflare Tunnel to your machine.
4. The local proxy receives the request, injects `Authorization: Bearer <token>`, and forwards it to OpenClaw.
5. OpenClaw responds with a chat completion. The lens parses `choices[0].message.content` and renders it on the AR display.

## Troubleshooting

See [`docs/troubleshooting.md`](docs/troubleshooting.md) for a full guide. Quick reference:

| Symptom | Cause | Fix |
|---|---|---|
| `status: 3` in lens | `InternetModule` internal error | Ensure endpoint is HTTPS and reachable; no `Authorization` header in lens code |
| HTTP 401 | Token mismatch | Check `OPENCLAW_GATEWAY_TOKEN` matches OpenClaw config; no extra spaces |
| HTTP 502 | Backend not running | Start OpenClaw gateway before the proxy |
| "Method Not Allowed" | Wrong path or method | Confirm the lens POSTs to `/v1/chat/completions` |

## Project Structure

```
openclaw-spectacles/
├── bridge/
│   ├── proxy.js                                  # Auth proxy (zero dependencies)
│   ├── install-macos.sh                          # macOS launchd installer
│   ├── install-linux.sh                          # Linux systemd installer
│   └── com.openclaw.spectacles-proxy.plist.template
├── lens/
│   ├── SpectaclesOpenClaw.ts                     # Lens Studio component
│   └── README.md                                 # Lens setup guide
├── docs/
│   ├── architecture.md                           # Deep-dive on design choices
│   └── troubleshooting.md                        # Error reference
└── README.md
```

## Contributing

Pull requests welcome. Please keep dependencies minimal and secrets out of commits.

## License

MIT — see [LICENSE](LICENSE).
