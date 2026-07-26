import { AiProvider, ChatMsg } from "./ai-provider.interface";

/**
 * G3 — mock provider is test-only and ALWAYS labeled. It never emits silent
 * plausible text: every response is prefixed with a visible banner.
 */
export class MockProvider implements AiProvider {
  readonly name = "mock";
  readonly labeled = true;

  async *streamChat(
    messages: ChatMsg[],
    _model: string,
  ): AsyncIterable<string> {
    const banner = "⚠️ [MOCK PROVIDER — no real AI configured] ";
    for (const word of banner.split(/(\s+)/)) {
      yield word;
      await new Promise((r) => setTimeout(r, 5));
    }
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const stub = `(stub reply to: "${(lastUser?.content ?? "").slice(0, 80)}")`;
    for (const word of stub.split(/(\s+)/)) {
      yield word;
      await new Promise((r) => setTimeout(r, 8));
    }
  }
}
