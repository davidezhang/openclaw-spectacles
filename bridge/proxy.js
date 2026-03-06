#!/usr/bin/env node
/**
 * bridge/proxy.js
 *
 * Lightweight auth proxy for openclaw-spectacles.
 *
 * Lens Studio's InternetModule silently strips Authorization headers, so this
 * proxy runs locally, injects the Bearer token, and forwards every request to
 * the OpenClaw gateway.
 *
 * Configuration via environment variables:
 *   OPENCLAW_GATEWAY_TOKEN  — required; Bearer token for the gateway
 *   OPENCLAW_GATEWAY_PORT   — optional; gateway port (default: 18789)
 *   PROXY_PORT              — optional; port this proxy listens on (default: 3210)
 *
 * Zero external dependencies — uses only Node.js built-ins.
 */

"use strict";

const http = require("http");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const GATEWAY_PORT = parseInt(process.env.OPENCLAW_GATEWAY_PORT || "18789", 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "3210", 10);

if (!TOKEN) {
  console.error(
    "[proxy] ERROR: OPENCLAW_GATEWAY_TOKEN is not set.\n" +
      "  Export it before starting the proxy:\n" +
      "    export OPENCLAW_GATEWAY_TOKEN=your-token-here"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

const server = http.createServer((clientReq, clientRes) => {
  const method = clientReq.method;
  const path = clientReq.url;

  // Build forwarded headers: copy everything from the client, then inject auth.
  const headers = Object.assign({}, clientReq.headers, {
    authorization: "Bearer " + TOKEN,
    host: "localhost:" + GATEWAY_PORT,
  });

  const options = {
    hostname: "127.0.0.1",
    port: GATEWAY_PORT,
    path: path,
    method: method,
    headers: headers,
  };

  const gatewayReq = http.request(options, (gatewayRes) => {
    clientRes.writeHead(gatewayRes.statusCode, gatewayRes.headers);
    gatewayRes.pipe(clientRes, { end: true });
  });

  gatewayReq.on("error", (err) => {
    console.error("[proxy] Gateway request error:", err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "text/plain" });
    }
    clientRes.end("502 Bad Gateway — could not reach OpenClaw on port " + GATEWAY_PORT);
  });

  clientReq.pipe(gatewayReq, { end: true });

  console.log(
    "[proxy]",
    method,
    path,
    "→ 127.0.0.1:" + GATEWAY_PORT
  );
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(
    "[proxy] Auth proxy listening on 127.0.0.1:" +
      PROXY_PORT +
      " → forwarding to 127.0.0.1:" +
      GATEWAY_PORT
  );
});

server.on("error", (err) => {
  console.error("[proxy] Server error:", err.message);
  process.exit(1);
});
