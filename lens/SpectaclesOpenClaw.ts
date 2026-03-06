/**
 * SpectaclesOpenClaw.ts
 *
 * Lens Studio component that sends a message to an OpenClaw gateway via
 * /v1/chat/completions and displays the reply on a Text component.
 *
 * Authorization is intentionally omitted — Lens Studio's InternetModule
 * strips Authorization headers. Point the endpoint at the auth proxy
 * (bridge/proxy.js) which injects the token server-side.
 */

@component
export class SpectaclesOpenClaw extends BaseScriptComponent {
  // Wire these in Inspector
  @input internetModule: InternetModule;
  @input replyText: Text;

  // Set endpoint to: https://your-tunnel.trycloudflare.com/v1/chat/completions
  @input endpoint: string = "";

  // Optional: pin to a specific OpenClaw session (e.g. "agent:main:main")
  @input sessionKey: string = "";

  @input testMessage: string = "hello from spectacles";

  // Spectacles have no touch screen — auto-fire after this delay (seconds)
  @input autoSendDelaySec: number = 2;

  private busy: boolean = false;
  private hasSent: boolean = false;

  onAwake() {
    this.setText("Starting...");

    const delayed = this.createEvent("DelayedCallbackEvent");
    delayed.bind(() => {
      if (!this.hasSent) {
        this.hasSent = true;
        this.sendMessage(this.testMessage);
      }
    });
    delayed.reset(Math.max(0, this.autoSendDelaySec));
  }

  private setText(t: string) {
    if (this.replyText) {
      this.replyText.text = t;
    } else {
      print(t);
    }
  }

  private async sendMessage(msg: string) {
    if (this.busy) return;
    if (!this.endpoint || this.endpoint.trim() === "") {
      this.setText("[Error] No endpoint configured");
      return;
    }

    this.busy = true;
    this.setText(`You: ${msg}\nThinking...`);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.sessionKey && this.sessionKey.trim() !== "") {
        headers["x-openclaw-session-key"] = this.sessionKey.trim();
      }

      const req = new Request(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          messages: [{ role: "user", content: msg }],
        }),
      });

      const res = await this.internetModule.fetch(req);

      if (res.status !== 200) {
        this.setText(`[Error] HTTP ${res.status}\n${this.endpoint}`);
        return;
      }

      const data = await res.json();
      const reply = data?.choices?.[0]?.message?.content ?? "(no reply)";
      this.setText(reply.trim());
    } catch (e) {
      print(`SpectaclesOpenClaw error: ${e}`);
      this.setText(`[Error] ${e}`);
    } finally {
      this.busy = false;
    }
  }
}
