import { randomUUID } from "node:crypto";
import { AiProvider, ChatMsg } from "./providers/ai-provider.interface";
import { NodeGatewayService } from "../nodes/node-gateway.service";

/**
 * Fast-lane provider bound to a warm realtime node. Sends realtime.chat.request
 * over the WS gateway and bridges the node's realtime.chat.token/done/error
 * events into an async token stream, with a timeout.
 */
export class RealtimeNodeProvider implements AiProvider {
  readonly name = "neurion_realtime_node";
  readonly labeled = false;

  constructor(
    private readonly gateway: NodeGatewayService,
    private readonly nodeId: string,
    private readonly timeoutMs = 60_000,
  ) {}

  // `signal` is part of the AiProvider contract; accepting it here keeps this
  // implementation honest with the interface instead of silently ignoring an
  // argument every caller is entitled to pass.
  async *streamChat(
    messages: ChatMsg[],
    model: string,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    const requestId = randomUUID();
    const queue: string[] = [];
    let done = false;
    let error: Error | null = null;
    let wake: (() => void) | null = null;
    const ping = () => {
      wake?.();
      wake = null;
    };

    const onToken = (e: { requestId: string; text: string }) => {
      if (e.requestId === requestId) {
        queue.push(e.text);
        ping();
      }
    };
    const onDone = (e: { requestId: string }) => {
      if (e.requestId === requestId) {
        done = true;
        ping();
      }
    };
    const onError = (e: { requestId: string; message?: string }) => {
      if (e.requestId === requestId) {
        error = new Error(e.message ?? "realtime error");
        done = true;
        ping();
      }
    };

    this.gateway.on("realtime.chat.token", onToken);
    this.gateway.on("realtime.chat.done", onDone);
    this.gateway.on("realtime.chat.error", onError);

    const sent = this.gateway.send(this.nodeId, {
      type: "realtime.chat.request",
      requestId,
      model,
      messages,
      stream: true,
      timeoutMs: this.timeoutMs,
    });
    const timer = setTimeout(() => {
      if (!done) {
        error = error ?? new Error("realtime timeout");
        done = true;
        ping();
      }
    }, this.timeoutMs);

    // An aborted request stops waiting on the node instead of holding the
    // listeners and the timer until the 60 s timeout expires.
    const onAbort = () => {
      if (done) return;
      error = error ?? new Error("aborted");
      done = true;
      ping();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    try {
      if (!sent) throw new Error("realtime node not reachable");
      for (;;) {
        if (queue.length) {
          yield queue.shift() as string;
          continue;
        }
        if (done) break;
        await new Promise<void>((r) => (wake = r));
      }
      if (error) throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.gateway.off("realtime.chat.token", onToken);
      this.gateway.off("realtime.chat.done", onDone);
      this.gateway.off("realtime.chat.error", onError);
    }
  }
}
