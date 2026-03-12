import {LOCAL_CONFIG} from "./LocalConfig"

@component
export class Agent extends BaseScriptComponent {
  @input internetModule: InternetModule;

  // Optional Inspector override. Leave blank to use LocalConfig.ts.
  @input endpoint: string = "";

  // Optional Inspector override. Leave blank to use LocalConfig.ts.
  @input sessionKey: string = "";

  private ImageQuality = CompressionQuality.HighQuality;
  private ImageEncoding = EncodingType.Jpg;

  onAwake() {}

  private getResolvedEndpoint(): string {
    if (this.endpoint && this.endpoint.trim() !== "") {
      return this.endpoint.trim();
    }
    return LOCAL_CONFIG?.endpoint?.trim?.() ?? "";
  }

  private getResolvedSessionKey(): string {
    if (this.sessionKey && this.sessionKey.trim() !== "") {
      return this.sessionKey.trim();
    }
    return LOCAL_CONFIG?.sessionKey?.trim?.() ?? "";
  }

  makeImageRequest(imageTex: Texture, callback: (response: string) => void) {
    print("Making image request...");
    Base64.encodeTextureAsync(
      imageTex,
      (base64String) => {
        print("Image encode Success!");
        const textQuery =
          "Identify in as much detail what object is in the image but only use a maximum of 5 words";
        this.sendAgentChat(textQuery, base64String, callback);
      },
      () => {
        print("Image encoding failed!");
      },
      this.ImageQuality,
      this.ImageEncoding
    );
  }

  async sendAgentChat(
    request: string,
    image64: string,
    callback: (response: string) => void
  ) {
    const endpoint = this.getResolvedEndpoint();
    const sessionKey = this.getResolvedSessionKey();

    if (!endpoint) {
      print("[Error] No endpoint configured");
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (sessionKey !== "") {
      headers["x-openclaw-session-key"] = sessionKey;
    }

    const req = new Request(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: request },
              {
                type: "image_url",
                image_url: {
                  url: "data:image/jpeg;base64," + image64,
                },
              },
            ],
          },
        ],
      }),
    });

    try {
      const res = await this.internetModule.fetch(req);
      if (res.status !== 200) {
        print(`[Error] HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      const reply = data?.choices?.[0]?.message?.content ?? "(no reply)";
      print("Response from OpenClaw: " + reply);
      callback(reply.trim());
    } catch (error) {
      print("Error in OpenClaw request: " + error);
    }
  }
}