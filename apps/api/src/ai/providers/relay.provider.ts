import { AiProvider, ChatMsg } from "./ai-provider.interface";

/**
 * Streams a completion from a REMOTE Neurion API's stateless /ai/infer endpoint
 * (which routes to a warm node in that API's shared pool). This is the desktop
 * relay: the agent loop runs on the local embedded API (to reach the user's files)
 * while the heavy LLM step is served by the community pool on the production API.
 * Billing + node reward happen on the remote side. See [[neurion-compute-control]].
 */
export class RelayProvider implements AiProvider {
  readonly name = "relay";
  readonly labeled = false;
  private lastNodeId: string | null = null;

  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  async *streamChat(
    messages: ChatMsg[],
    model: string,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    const res = await fetch(`${this.base.replace(/\/$/, "")}/api/ai/infer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ messages, model }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`relay HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        if (event === "token") {
          try {
            yield (JSON.parse(data) as { t: string }).t;
          } catch {
            /* skip */
          }
        } else if (event === "node") {
          try {
            this.lastNodeId = (JSON.parse(data) as { nodeId: string }).nodeId;
          } catch {
            /* skip */
          }
        } else if (event === "error") {
          let msg = "relay error";
          try {
            msg = (JSON.parse(data) as { message: string }).message;
          } catch {
            /* keep default */
          }
          throw new Error(msg);
        }
        // 'done' ends the stream naturally
      }
    }
  }

  nodeId(): string | null {
    return this.lastNodeId;
  }
}
