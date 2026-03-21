// Auth-injecting proxy for Spectacles -> OpenClaw Gateway
// - Injects Bearer token
// - Injects system prompt for concise AR display replies
// - Extracts image_url content parts, saves to disk, and instructs
//   the agent to use the image tool (workaround for gateway stripping
//   image_url from chat completions content arrays)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const GATEWAY = process.env.OPENCLAW_GATEWAY_HOST || "127.0.0.1";
const GATEWAY_PORT = parseInt(process.env.OPENCLAW_GATEWAY_PORT || "18789", 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "3210", 10);
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const LOG_FILE = process.env.SPECTACLES_PROXY_LOG_FILE || path.join(process.env.HOME || process.cwd(), ".openclaw", "spectacles-proxy.log");
const IMAGE_DIR = process.env.SPECTACLES_IMAGE_DIR || path.join(process.env.HOME || process.cwd(), ".openclaw", "workspace", "tmp", "spectacles-captures");

if (!TOKEN) {
  console.error("[proxy] ERROR: OPENCLAW_GATEWAY_TOKEN is not set.");
  process.exit(1);
}

// Ensure image dir exists
if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });

const SPECTACLES_SYSTEM = {
  role: "system",
  content: [
    "You are responding on Snap Spectacles AR glasses.",
    "The user is talking to you via voice (speech-to-text) and reads your reply on a small AR display.",
    "Rules for this surface:",
    "- Keep replies to 1-2 SHORT sentences max (~80 chars ideal, never exceed 150).",
    "- No markdown, no bullet points, no formatting — plain text only.",
    "- Be direct and conversational, like a voice assistant.",
    "- When performing actions (opening browser, playing music, etc.), confirm briefly: 'Done, playing lo-fi beats on YouTube.'",
    "- If a task fails, say what went wrong in one sentence.",
    "- No emojis.",
  ].join(" "),
};

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

function collectBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * Extract image_url parts from a content array, save to disk,
 * and return { textParts, imagePaths }.
 */
function extractAndSaveImages(content) {
  const textParts = [];
  const imagePaths = [];

  for (const part of content) {
    if (part.type === "text") {
      textParts.push(part.text);
    } else if (part.type === "image_url" && part.image_url?.url) {
      const url = part.image_url.url;
      const match = url.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
      if (match) {
        const ext = match[1] === "jpg" ? "jpeg" : match[1];
        const b64 = match[2];
        const id = crypto.randomBytes(6).toString("hex");
        const bytes = Buffer.from(b64, "base64");
        const filePath = path.join(IMAGE_DIR, `capture-${id}.${ext}`);
        fs.writeFileSync(filePath, bytes);
        imagePaths.push(filePath);
        log(`   saved image: ${filePath} (${bytes.length} bytes)`);
      } else if (url.startsWith("http")) {
        // Remote URL — pass as-is for agent to fetch
        imagePaths.push(url);
      }
    }
  }

  return { textParts, imagePaths };
}

http.createServer(async (req, res) => {
  const id = Date.now().toString(36);
  log(`-> ${id} ${req.method} ${req.url} from=${req.socket.remoteAddress}`);

  try {
    let body = await collectBody(req);

    if (req.method === "POST" && req.url.includes("/v1/chat/completions")) {
      try {
        const json = JSON.parse(body.toString());
        if (Array.isArray(json.messages)) {
          for (const msg of json.messages) {
            if (msg.role === "user" && Array.isArray(msg.content)) {
              const { textParts, imagePaths } = extractAndSaveImages(msg.content);
              if (imagePaths.length > 0) {
                const userText = textParts.join(" ").trim() || "What is this?";
                const imageRefs = imagePaths.map((p) => `  ${p}`).join("\n");
                msg.content =
                  userText +
                  "\n\n[The user captured an image from their Spectacles AR glasses." +
                  " The image has been saved to:\n" +
                  imageRefs +
                  "\nUse the image analysis tool to examine it, then answer the user's question concisely.]";
                log(`   ${id} extracted ${imagePaths.length} image(s), text: \"${userText.substring(0, 60)}...\"`);
              }
            }
          }

          const hasSystem = json.messages.some((m) => m.role === "system");
          if (!hasSystem) {
            json.messages.unshift(SPECTACLES_SYSTEM);
          }

          body = Buffer.from(JSON.stringify(json));
        }
      } catch (e) {
        log(`!! ${id} JSON parse error: ${e.message}`);
      }
    }

    const headers = { ...req.headers, authorization: `Bearer ${TOKEN}` };
    headers["content-length"] = body.length;

    const proxy = http.request(
      {
        hostname: GATEWAY,
        port: GATEWAY_PORT,
        path: req.url,
        method: req.method,
        headers,
      },
      (pRes) => {
        log(`<- ${id} ${pRes.statusCode}`);
        res.writeHead(pRes.statusCode, pRes.headers);
        pRes.pipe(res);
      }
    );

    proxy.on("error", (err) => {
      log(`!! ${id} proxy error: ${err.message}`);
      res.writeHead(502);
      res.end();
    });

    proxy.end(body);
  } catch (err) {
    log(`!! ${id} request error: ${err.message}`);
    res.writeHead(500);
    res.end();
  }
}).listen(PROXY_PORT, "127.0.0.1", () => {
  log(`Spectacles auth proxy on :${PROXY_PORT} -> gateway :${GATEWAY_PORT}`);
});
