# Architecture Deep Dive

## Overview

```
Spectacles Lens  ──HTTPS──►  Cloudflare Tunnel  ──HTTP──►  Auth Proxy :3210  ──HTTP──►  OpenClaw Gateway :18789
```

The stack is intentionally minimal: one TypeScript file on the lens, one Node.js file on the host machine, and Cloudflare's free tunnel service in between. No custom server, no cloud function, no additional infrastructure.

---

## Why This Approach?

### Option A — Direct HTTPS from Lens to OpenClaw (rejected)

The simplest design would expose the OpenClaw gateway directly on the internet (via port forwarding or a VPS) and have the lens talk to it over HTTPS with an `Authorization` header.

**Why it was rejected:** Lens Studio's `InternetModule` silently drops the `Authorization` header before the HTTP request is dispatched. This is not documented; it was discovered by elimination. The lens would receive HTTP 401 from every authenticated endpoint regardless of what the TypeScript code set. There is no way to rename or work around this at the lens level — the header stripping appears to happen inside the closed-source `InternetModule` runtime.

### Option B — Custom authentication scheme (rejected)

Embedding the token in the URL (e.g., as a query parameter) or in a non-standard header would bypass the `InternetModule` restriction, but exposes the token in server logs, Cloudflare logs, and browser history if the URL is ever pasted.

### Option C — Tailscale / private VPN (considered)

Spectacles can join a Tailscale network, allowing direct access to internal services without exposing a public endpoint. This is a valid approach for teams already using Tailscale.

**Why it was not chosen as the default:** Requires installing Tailscale on both the Spectacles device and the host machine, and involves more setup. The Cloudflare Tunnel approach works out of the box with a single command.

### Option D — Cloudflare Worker as token injector (considered)

A Cloudflare Worker could sit in front of OpenClaw, validate a lightweight client credential, and inject the real gateway token. This removes the need for a local proxy entirely.

**Why it was not chosen:** Requires a Cloudflare account with Workers enabled, adds a round-trip to Cloudflare's edge, and moves secret management to a cloud service. The local proxy keeps all secrets on the user's own machine.

### Option E — Local auth proxy + Cloudflare Tunnel (chosen)

The chosen approach:

1. A trivial Node.js HTTP proxy runs on `localhost:3210`. It has zero npm dependencies and fits in ~70 lines.
2. The proxy injects `Authorization: Bearer <token>` on every forwarded request.
3. Cloudflare Tunnel exposes `localhost:3210` via a stable `trycloudflare.com` HTTPS URL. No port forwarding or DNS configuration required.
4. The lens calls the tunnel URL. `InternetModule` sees no `Authorization` header in the lens code, so nothing is stripped.

**Trade-offs:**
- The machine running the proxy must be on and connected to the internet while the lens is in use. Acceptable for a personal assistant use case.
- The gateway token lives in an environment variable on the host — never in the lens code or any repository.

---

## The Authorization Header Discovery

The root cause of the `status: 3` error that many developers hit when building authenticated Spectacles lenses:

1. Lens Studio's `InternetModule` uses a sandboxed HTTP client.
2. The sandbox removes the `Authorization` header from outgoing requests. This is likely a security measure to prevent lenses from exfiltrating credentials obtained via phishing, but it is not documented in Snap's developer docs.
3. The symptom is `status: 3` — an `InternetModule`-internal error code indicating the request could not be dispatched, not an HTTP status code from the server.
4. Once the `Authorization` header is removed from the lens code entirely, `status: 3` goes away and the request reaches the server (where it then gets HTTP 401 because the token is missing — which is the local proxy's job to fix).

---

## Security Considerations

| Concern | Mitigation |
|---|---|
| Token in transit | Cloudflare Tunnel uses TLS end-to-end from the lens to the tunnel endpoint. Local traffic (tunnel → proxy → gateway) is loopback-only. |
| Token at rest | The token is stored in an environment variable or a launchd/systemd unit file owned by the user. It is never written to disk in the lens bundle or this repository. |
| Public tunnel endpoint | The tunnel URL is ephemeral (changes every time for quick tunnels) and only forwards to `localhost`, so it cannot be used to reach other local services. |
| Replay attacks | The gateway token is a long-lived shared secret. Rotate it in OpenClaw's settings if you suspect compromise. |
| Lens bundle contents | The lens `.lns` file does not contain the token (the TypeScript code has no secrets). It is safe to share the compiled lens. |

---

## Sequence Diagram

```
Spectacles Lens
    │
    │  POST /v1/chat/completions
    │  Content-Type: application/json
    │  (no Authorization header)
    │
    ▼
Cloudflare Tunnel  (TLS termination)
    │
    │  POST /v1/chat/completions
    │  Content-Type: application/json
    │
    ▼
Auth Proxy  localhost:3210
    │
    │  POST /v1/chat/completions
    │  Content-Type: application/json
    │  Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>   ← injected here
    │
    ▼
OpenClaw Gateway  localhost:18789
    │
    │  HTTP 200
    │  {"choices":[{"message":{"content":"..."}}]}
    │
    ▼ (reversed)
Spectacles Lens  →  displays choices[0].message.content
```
