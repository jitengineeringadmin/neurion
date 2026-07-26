import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Produces the TRUSTED reference output used to deep-verify a node's work.
 * Invariant C2: the reference is generated only here (fallback/in-process) — a
 * community peer can NEVER be the reference, so a sybil ring can't vouch for itself.
 *
 * echo.v1 is verified in-process (free, exact). embedding.v1 re-execution loads the
 * same pinned model (all-MiniLM-L6-v2) via @huggingface/transformers, which is heavy
 * (onnxruntime) — it is OPTIONAL and gated by VERIFY_EMBEDDING_ENABLED so the lean
 * desktop build doesn't ship it; production enables it.
 */
@Injectable()
export class TrustedExecutorService {
  private readonly logger = new Logger(TrustedExecutorService.name);
  private embedder:
    | ((text: string, opts: unknown) => Promise<{ data: Float32Array }>)
    | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Whether this job type can be deep-verified in the current deployment. */
  available(jobType: string): boolean {
    if (jobType === "echo.v1") return true;
    if (jobType === "embedding.v1")
      return (
        String(this.config.get("VERIFY_EMBEDDING_ENABLED") ?? "false") ===
        "true"
      );
    return false;
  }

  /** Trusted reference output, or null if this deployment can't verify the type. */
  async reference(
    jobType: string,
    inputJson: unknown,
  ): Promise<Record<string, unknown> | null> {
    const input = (inputJson ?? {}) as { text?: string };
    if (jobType === "echo.v1") {
      return { echo: String(input.text ?? "") };
    }
    if (jobType === "embedding.v1" && this.available(jobType)) {
      try {
        if (!this.embedder) {
          // dynamic specifier via a variable so TS doesn't require the optional dep at build
          const spec = "@huggingface/transformers";
          const tf = (await import(spec)) as {
            pipeline: (
              task: string,
              model: string,
            ) => Promise<
              (t: string, o: unknown) => Promise<{ data: Float32Array }>
            >;
          };
          this.embedder = await tf.pipeline(
            "feature-extraction",
            "Xenova/all-MiniLM-L6-v2",
          );
        }
        const out = await this.embedder(String(input.text ?? ""), {
          pooling: "mean",
          normalize: true,
        });
        return { vector: Array.from(out.data) };
      } catch (e) {
        this.logger.error(
          `embedding reference executor unavailable: ${(e as Error).message}`,
        );
        return null;
      }
    }
    return null;
  }
}
