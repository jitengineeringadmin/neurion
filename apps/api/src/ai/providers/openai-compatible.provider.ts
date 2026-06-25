import { AiProvider, ChatMsg } from './ai-provider.interface';

/**
 * Streams from any OpenAI-compatible /chat/completions endpoint (e.g. ollama).
 * Used as the real Fallback-lane provider in dev (G3).
 */
export class OpenAICompatibleProvider implements AiProvider {
  readonly name = 'openai_compatible';
  readonly labeled = false;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async *streamChat(messages: ChatMsg[], model: string, signal?: AbortSignal): AsyncIterable<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
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
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // ignore keep-alive / partial lines
        }
      }
    }
  }
}
