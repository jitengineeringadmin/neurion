/**
 * Reasoning models (DeepSeek R1, Qwen 3) wrap their scratchpad in <think>…</think>
 * and stream it as ordinary content. ollama reports it out of band, so the native
 * provider never had to care — but the bundled llama.cpp server speaks plain
 * OpenAI, which means without this the user watches the model think out loud
 * inside the answer bubble.
 *
 * Fed one streamed delta at a time, since the tags routinely arrive split across
 * chunks ("<th" + "ink>"). Returns the text that belongs in the answer; anything
 * inside the block is handed to onReasoning instead.
 */
export class ThinkSplitter {
  private inside = false;
  /** Partial text held back because it might be the start of a tag. */
  private pending = "";

  constructor(private readonly onReasoning?: (delta: string) => void) {}

  push(chunk: string): string {
    let visible = "";
    let text = this.pending + chunk;
    this.pending = "";

    for (;;) {
      const tag = this.inside ? "</think>" : "<think>";
      const at = text.indexOf(tag);
      if (at >= 0) {
        const before = text.slice(0, at);
        if (this.inside) this.onReasoning?.(before);
        else visible += before;
        text = text.slice(at + tag.length);
        this.inside = !this.inside;
        continue;
      }
      // No complete tag. A trailing partial one must be held back, or "<" would
      // reach the user a moment before we learn it was "<think>".
      const keep = ThinkSplitter.partialTagLength(text, tag);
      if (keep > 0) {
        this.pending = text.slice(text.length - keep);
        text = text.slice(0, text.length - keep);
      }
      if (this.inside) this.onReasoning?.(text);
      else visible += text;
      return visible;
    }
  }

  /** Flush whatever was held back; call once the stream ends. */
  end(): string {
    const rest = this.pending;
    this.pending = "";
    if (!rest) return "";
    if (this.inside) {
      this.onReasoning?.(rest);
      return "";
    }
    return rest;
  }

  /** Length of the suffix of `text` that is a prefix of `tag` (0 if none). */
  private static partialTagLength(text: string, tag: string): number {
    const max = Math.min(text.length, tag.length - 1);
    for (let n = max; n > 0; n--) {
      if (text.endsWith(tag.slice(0, n))) return n;
    }
    return 0;
  }
}
