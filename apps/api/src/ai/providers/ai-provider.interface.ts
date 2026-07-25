export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[]; // base64 data URLs (data:image/...;base64,…) for vision models
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatOptions {
  maxTokens?: number;
}

export interface AiProvider {
  /** Provider id written to ChatMessage.providerUsed (e.g. "mock", "openai_compatible"). */
  readonly name: string;
  /** Whether output must be surfaced as non-authoritative (G3: mock is always labeled). */
  readonly labeled: boolean;
  /** Stream assistant text deltas for the given messages. */
  streamChat(
    messages: ChatMsg[],
    model: string,
    signal?: AbortSignal,
    options?: ChatOptions,
  ): AsyncIterable<string>;
  /** Real token usage from the most recent streamChat, if the provider reports it. */
  getUsage?(): TokenUsage | null;
}
