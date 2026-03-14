# openclaw-spectacles

Connect [Snap Spectacles](https://spectacles.com) AR glasses to [OpenClaw](https://openclaw.ai) — an AI assistant platform — using a lightweight local auth proxy and Cloudflare Tunnel.

This repo now has two main goals:

1. include the full Lens Studio project, not just a few key scripts, so the project can be opened, tested, and shared directly from GitHub
2. add POV cropping so OpenClaw understands both what you are seeing and the specific region you want it to focus on

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

### 6. Open the Lens Studio project

This repo now includes the full Lens Studio project, not just extracted helper scripts, at:

- `lens-project/Spectacles_OpenClaw`

Open `lens-project/Spectacles_OpenClaw/OpenClaw_Crop.esproj` in Lens Studio.

That project includes the POV cropping flow, so OpenClaw can understand both your first-person view and the specific crop region you want it to analyze.

### 7. Configure your local endpoint

The shared Lens project now reads local endpoint/session settings from a git-ignored file:

- `lens-project/Spectacles_OpenClaw/Assets/Scripts/LocalConfig.ts`

Setup:

1. Copy:
   - `lens-project/Spectacles_OpenClaw/Assets/Scripts/LocalConfig.example.ts`
   - to `lens-project/Spectacles_OpenClaw/Assets/Scripts/LocalConfig.ts`
2. Edit it with your local values:
   - `endpoint: "https://your-tunnel.example.com/v1/chat/completions"`
   - `sessionKey: "agent:main:main"` (optional)
3. Keep the Agent Inspector fields blank unless you explicitly want to override the local config.

`LocalConfig.ts` is git-ignored, so your private tunnel URL stays local.

The full shared Lens Studio project in `lens-project/Spectacles_OpenClaw/` is now the canonical Lens source of truth.

## How It Works

The lens supports two interaction modes: **pinch-to-crop** (two hands) for capturing images, and **pinch-to-talk** (right hand) for voice queries. Images are staged — not auto-sent — and paired with a voice query before being sent to OpenClaw.

### Image Capture (Two-Hand Pinch)
1. Pinch both hands close together — a scanner spawns and you drag a crop rectangle by moving your hands.
2. Release both pinches — the cropped image is **staged** (captured but not yet sent). The frame displays at full size for 2 seconds, then shrinks to the lower part of your view.
3. The staged image remains available for **30 seconds**. A new crop within this window replaces the existing staged image.
4. After 30 seconds with no voice query, the staged image is discarded.

### Voice Query (Right-Hand Pinch-and-Hold)
1. Pinch and hold your **right hand** — the lens starts listening via `AsrModule` and shows your transcribed speech live in AR.
2. Release the pinch — the lens stops recording, takes the final transcript, and:
   - If an image is staged: sends both the image and your voice query together as a multimodal request.
   - If no image is staged: sends a text-only query.
3. The request POSTs `{"messages":[{"role":"user","content":...}]}` to `<endpoint>/v1/chat/completions`.
4. The request travels over HTTPS through the Cloudflare Tunnel to your machine.
5. The local proxy receives the request, injects `Authorization: Bearer <token>`, and forwards it to OpenClaw.
6. OpenClaw responds with a chat completion. The lens parses `choices[0].message.content` and renders it on the AR display.

### Gesture Disambiguation
- **Two hands pinching close together** → image crop mode
- **Right hand pinch only** (left hand open) → voice recording
- ASR is suppressed while the crop scanner is active

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
├── lens-project/
│   └── Spectacles_OpenClaw/                      # Full Lens Studio project (canonical shared Lens source)
│       └── Assets/Scripts/
│           ├── Agent.ts                           # API client (image+text and text-only requests)
│           ├── VoiceQueryController.ts            # Pinch-and-hold ASR + staged image manager
│           ├── PictureController.ts               # Two-hand pinch → spawn crop scanner
│           ├── PictureBehavior.ts                 # Crop rectangle tracking → stages image
│           ├── CaptionBehavior.ts                 # Animated response text display
│           ├── CameraService.ts                   # Camera init + coordinate transforms
│           ├── CropRegion.ts                      # Dynamic crop rect from tracked points
│           └── LocalConfig.ts                     # Endpoint + session key (git-ignored)
├── docs/
│   ├── architecture.md                           # Deep-dive on design choices
│   └── troubleshooting.md                        # Error reference
└── README.md
```

## Contributing

Pull requests welcome. Please keep dependencies minimal and secrets out of commits.

For Lens Studio projects in this repo:
- do not commit `Cache/`, `PluginsUserPreferences/`, `Workspaces/`, or `.DS_Store`
- do not commit private tunnel URLs or personal session keys in `Scene.scene`
- keep private values in `Assets/Scripts/LocalConfig.ts` (git-ignored)
- `LocalConfig.example.ts` is the checked-in template

## License

MIT — see [LICENSE](LICENSE).
