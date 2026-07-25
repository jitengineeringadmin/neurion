import {
  AiProvider,
  ChatMsg,
  ChatOptions,
  TokenUsage,
} from "./ai-provider.interface";

/**
 * Streams from ollama's NATIVE /api/chat instead of its OpenAI-compatible /v1
 * layer.
 *
 * The /v1 layer only accepts standard OpenAI fields, which means it cannot
 * carry `num_ctx` or `keep_alive` — and both decide whether a model is usable
 * at all. Measured on a CPU-only machine with qwen3:30b-a3b: ollama's default
 * context of 262144 tokens reserved a 45 GB working set and produced 4.1 tok/s,
 * while the same model capped to an 8k context took 19 GB and produced
 * 17.6 tok/s. Same weights, four times the speed, less than half the memory.
 *
 * Capping the context is not a downgrade here: the prompt is already compiled
 * to fit AgentContextService's budget, which defaults to the same 8k.
 */
export class OllamaNativeProvider implements AiProvider {
  readonly labeled = false;
  readonly name = "ollama";
  private usage: TokenUsage | null = null;

  constructor(
    /** Base WITHOUT the /v1 suffix, e.g. http://127.0.0.1:11434 */
    private readonly baseUrl: string,
    private readonly numCtx: number,
    /** ollama TTL: '-1' pins the model, '30m' expires, '0' unloads immediately. */
    private readonly keepAlive: string,
  ) {}

  getUsage(): TokenUsage | null {
    return this.usage;
  }

  async *streamChat(
    messages: ChatMsg[],
    model: string,
    signal?: AbortSignal,
    options?: ChatOptions,
  ): AsyncIterable<string> {
    this.usage = null;
    // Native format: images ride alongside the message as bare base64, without
    // the data: URL wrapper the /v1 content-array format uses.
    const wire = messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.images?.length
        ? { images: m.images.map((u) => u.replace(/^data:[^;]+;base64,/, "")) }
        : {}),
    }));

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: wire,
        stream: true,
        keep_alive: this.keepAlive,
        options: {
          num_ctx: this.numCtx,
          ...(options?.maxTokens ? { num_predict: options.maxTokens } : {}),
        },
      }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`ollama HTTP ${res.status}`);

    // NDJSON, one JSON object per line — not SSE.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const json = JSON.parse(trimmed) as {
            message?: { content?: string; thinking?: string };
            done?: boolean;
            error?: string;
            prompt_eval_count?: number;
            eval_count?: number;
          };
          if (json.error) throw new Error(json.error);
          // Reasoning models stream `thinking` with an empty `content` for many
          // seconds before answering. Report it so the caller can show progress,
          // but never mix it into the answer text.
          const thinking = json.message?.thinking;
          if (thinking) options?.onReasoning?.(thinking);
          const delta = json.message?.content;
          if (delta) yield delta;
          if (json.done) {
            const prompt = json.prompt_eval_count ?? 0;
            const completion = json.eval_count ?? 0;
            this.usage = {
              promptTokens: prompt,
              completionTokens: completion,
              totalTokens: prompt + completion,
            };
            return;
          }
        } catch (e) {
          // A reported engine error must surface; a partial line must not.
          if (e instanceof Error && e.message && !/JSON/i.test(e.message)) throw e;
        }
      }
    }
  }
}
