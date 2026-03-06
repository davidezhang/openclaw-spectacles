# Troubleshooting

A reference for every error encountered while building this integration.

---

## `status: 3` in the Lens

**Symptom:** The lens shows `[Error] HTTP 3 from ...` or the `InternetModule` callback receives a response object with `status === 3`.

**Cause:** This is *not* an HTTP status code — it is an `InternetModule`-internal error code meaning the request was rejected before it left the device. The most common cause is an `Authorization` header in the request. Lens Studio's `InternetModule` sandbox silently strips this header, then (in some Lens Studio versions) aborts the request entirely with status 3.

**Fix:**
1. Remove the `Authorization` header from your TypeScript code completely.
2. Delegate auth to the local proxy (`bridge/proxy.js`), which injects the header server-side where the sandbox cannot interfere.
3. Ensure the endpoint URL is `https://` (not `http://`) — `InternetModule` may also reject plain HTTP.

---

## HTTP 401 Unauthorized

**Symptom:** The lens shows `[Error] HTTP 401 from https://...` or the proxy logs show `401` responses from the gateway.

**Cause:** The `Authorization` header reached the gateway but the token was rejected.

**Common causes and fixes:**

| Cause | Fix |
|---|---|
| `OPENCLAW_GATEWAY_TOKEN` is not set | `export OPENCLAW_GATEWAY_TOKEN=your-token && node bridge/proxy.js` |
| Token has leading/trailing whitespace | Re-export the variable without quotes that include spaces: `export OPENCLAW_GATEWAY_TOKEN=abc123` |
| Token was copied with a newline | Use `echo -n "your-token" \| pbcopy` (macOS) to copy without a trailing newline |
| Token does not match what OpenClaw expects | Open OpenClaw settings, copy the gateway token, and re-export |
| Proxy is not running | Start `node bridge/proxy.js` and confirm it logs `listening on 127.0.0.1:3210` |

**Verification:** Test the proxy directly with curl:

```bash
curl -v http://localhost:3210/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"ping"}]}'
```

If you see `Authorization: Bearer ...` in the curl verbose output from the proxy side, the proxy is injecting the header correctly. A 401 from here means OpenClaw is rejecting the specific token value.

---

## HTTP 502 Bad Gateway

**Symptom:** The lens shows `[Error] HTTP 502 from https://...` or `curl` to the proxy returns a 502.

**Cause:** The proxy could not reach the OpenClaw gateway. Either the gateway is not running, or it is listening on a different port.

**Fix:**
1. Start the OpenClaw gateway first, then start the proxy.
2. Confirm the gateway port with:
   ```bash
   lsof -i :18789   # macOS / Linux
   ```
3. If the gateway uses a non-default port, set `OPENCLAW_GATEWAY_PORT` before starting the proxy:
   ```bash
   OPENCLAW_GATEWAY_PORT=12345 node bridge/proxy.js
   ```
4. Confirm the proxy forwards to the right address by checking its startup log:
   ```
   [proxy] Auth proxy listening on 127.0.0.1:3210 → forwarding to 127.0.0.1:18789
   ```

---

## "Method Not Allowed" (HTTP 405)

**Symptom:** The lens or curl receives HTTP 405 Method Not Allowed.

**Cause:** The request is reaching OpenClaw but using the wrong HTTP method or path.

**Fix:**
1. Confirm the lens TypeScript is using `method: "POST"`.
2. Confirm the path is exactly `/v1/chat/completions` (no trailing slash, no extra segments).
3. Some versions of OpenClaw may require a different path prefix — check your OpenClaw documentation.

---

## Tunnel URL Not Reachable

**Symptom:** The lens gets a network error or timeout before any HTTP status code is returned.

**Cause:** The Cloudflare Tunnel is not running or the URL has changed.

**Fix:**
1. Confirm `cloudflared` is running and has printed a `trycloudflare.com` URL.
2. Quick tunnels generate a *new* URL every time `cloudflared` restarts. Update the **Endpoint** field in the lens Inspector if you restarted the tunnel.
3. For a stable URL, use a named tunnel tied to your Cloudflare account (requires a free Cloudflare account).

---

## Lens Shows `...` (Stuck Loading)

**Symptom:** The reply Text component shows `...` indefinitely.

**Cause:** The request was sent but no response callback was invoked. This usually means the request timed out or `InternetModule` silently dropped it.

**Fix:**
1. Check the proxy logs — if no `[proxy] POST /v1/chat/completions` line appears, the request never left the lens (re-check the tunnel URL).
2. Increase `autoSendDelaySec` if the lens is sending the request before the scene is fully loaded.
3. Check the OpenClaw gateway for a request that never completed (the model may be slow to respond on first load).
