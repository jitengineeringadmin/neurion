import { AiProvider, ChatMsg, TokenUsage } from './ai-provider.interface';

/**
 * Streams from any OpenAI-compatible /chat/completions endpoint (e.g. ollama, ds4).
 * Used as the real Fallback-lane provider in dev (G3). Captures real token usage
 * (stream_options.include_usage) for cost reconciliation when the backend reports it.
 */
export class OpenAICompatibleProvider implements AiProvider {
  readonly labeled = false;
  private usage: TokenUsage | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    // route-badge id; ds4 (antirez DwarfStar) reuses this provider with name 'ds4'.
    readonly name: string = 'openai_compatible',
  ) {}

  getUsage(): TokenUsage | null {
    return this.usage;
  }

  async *streamChat(messages: ChatMsg[], model: string, signal?: AbortSignal): AsyncIterable<string> {
    this.usage = null;
    // Vision: a message with images becomes the OpenAI content-array format
    // (text part + image_url parts) that ollama's /v1 endpoint accepts for llava etc.
    const wire = messages.map((m) =>
      m.images && m.images.length
        ? { role: m.role, content: [{ type: 'text', text: m.content }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))] }
        : { role: m.role, content: m.content },
    );
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model, messages: wire, stream: true, stream_options: { include_usage: true } }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`provider HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice('data:'.length).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
          };
          if (json.usage) {
            this.usage = {
              promptTokens: json.usage.prompt_tokens ?? 0,
              completionTokens: json.usage.completion_tokens ?? 0,
              totalTokens: json.usage.total_tokens ?? 0,
            };
          }
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // ignore keep-alive / partial lines
        }
      }
    }
  }
}
