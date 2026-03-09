/**
 * SpectaclesOpenClaw.ts
 *
 * Pinch-to-talk: hold pinch to record speech, release to send to OpenClaw.
 *
 * Uses:
 * - GestureModule for pinch detection (hold = recording, release = send)
 * - AsrModule for on-device speech-to-text
 * - InternetModule to POST to OpenClaw gateway via auth proxy
 *
 * Authorization header is intentionally omitted — Lens Studio's
 * InternetModule strips it. The local auth proxy (bridge/proxy.js)
 * injects the Bearer token server-side.
 */

@component
export class SpectaclesOpenClaw extends BaseScriptComponent {
  @input internetModule: InternetModule;
  @input replyText: Text;

  // Set to: https://your-tunnel.trycloudflare.com/v1/chat/completions
  @input endpoint: string = "";

  // Optional: pin to a specific OpenClaw session
  @input sessionKey: string = "agent:main:main";

  // Which hand triggers pinch-to-talk
  @input useRightHand: boolean = true;

  private gestureModule: GestureModule = require("LensStudio:GestureModule");
  private asrModule = require("LensStudio:AsrModule");

  private busy: boolean = false;
  private isRecording: boolean = false;
  private transcript: string = "";

  onAwake() {
    this.setText("Ready. Pinch and hold to talk.");

    const handType = this.useRightHand
      ? GestureModule.HandType.Right
      : GestureModule.HandType.Left;

    // Pinch down = start listening
    this.gestureModule.getPinchDownEvent(handType).add(() => {
      if (this.busy) return;
      this.startListening();
    });

    // Pinch up = stop listening and send
    this.gestureModule.getPinchUpEvent(handType).add(() => {
      if (this.isRecording) {
        this.stopListeningAndSend();
      }
    });
  }

  private startListening() {
    this.isRecording = true;
    this.transcript = "";
    this.setText("Listening...");

    const options = AsrModule.AsrTranscriptionOptions.create();
    options.silenceUntilTerminationMs = 2000;
    options.mode = AsrModule.AsrMode.HighAccuracy;

    options.onTranscriptionUpdateEvent.add(
      (eventArgs: AsrModule.TranscriptionUpdateEvent) => {
        this.transcript = eventArgs.text;
        this.setText(`"${eventArgs.text}"${eventArgs.isFinal ? "" : "..."}`);
      }
    );

    options.onTranscriptionErrorEvent.add(
      (errorCode: AsrModule.AsrStatusCode) => {
        print(`ASR error: ${errorCode}`);
        this.setText(`[ASR Error] ${errorCode}`);
        this.isRecording = false;
      }
    );

    this.asrModule.startTranscribing(options);
  }

  private stopListeningAndSend() {
    this.isRecording = false;
    this.asrModule.stopTranscribing();

    const text = this.transcript.trim();
    if (!text) {
      this.setText("No speech detected. Try again.");
      return;
    }

    this.sendMessage(text);
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
        this.setText(`[Error] HTTP ${res.status}`);
        return;
      }

      const data = await res.json();
      const reply = data?.choices?.[0]?.message?.content ?? "(no reply)";
      this.setText(reply.trim());
    } catch (e) {
      print(`Network error: ${e}`);
      this.setText(`[Error] ${e}`);
    } finally {
      this.busy = false;
    }
  }
}
