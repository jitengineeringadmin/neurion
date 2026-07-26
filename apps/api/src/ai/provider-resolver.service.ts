import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiProvider } from "./providers/ai-provider.interface";
import { MockProvider } from "./providers/mock.provider";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.provider";
import { OllamaNativeProvider } from "./providers/ollama-native.provider";

export interface ResolvedProvider {
  provider: AiProvider;
  model: string;
}

/**
 * G3 — provider resolution order: explicit override -> (test => mock) ->
 * real ollama if reachable -> LOUD labeled mock as last resort. Mock is never
 * chosen silently in dev.
 */
@Injectable()
export class ProviderResolverService {
  private readonly logger = new Logger(ProviderResolverService.name);
  private readonly mock = new MockProvider();

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return (
      this.config.get<string>("AI_OPENAI_COMPATIBLE_BASE_URL") ??
      "http://localhost:11434/v1"
    );
  }

  /** ds4 / DwarfStar (antirez) — native DeepSeek V4 engine, OpenAI-compatible. Optional. */
  private get ds4BaseUrl(): string | undefined {
    return this.config.get<string>("AI_DS4_BASE_URL") || undefined;
  }
  private get ds4Model(): string {
    return this.config.get<string>("AI_DS4_MODEL") ?? "deepseek-v4-flash";
  }
  /** LM Studio's OpenAI-compatible server. Set to '' to disable the probe. */
  private get lmStudioBaseUrl(): string | undefined {
    const v = this.config.get<string>("AI_LMSTUDIO_BASE_URL");
    return v === undefined ? "http://127.0.0.1:1234/v1" : v || undefined;
  }
  private apiKey(): string {
    return (
      this.config.get<string>("AI_OPENAI_COMPATIBLE_API_KEY") ?? "local-dev"
    );
  }

  /** Context window requested from ollama. See OllamaNativeProvider for why. */
  private numCtx(): number {
    return Math.max(
      2048,
      Number(this.config.get<string>("AI_OLLAMA_NUM_CTX") ?? 8192) || 8192,
    );
  }
  private keepAlive(): string {
    return this.config.get<string>("AI_OLLAMA_KEEP_ALIVE") ?? "30m";
  }

  /**
   * Build the provider for a source. ollama gets its native endpoint so the
   * context can be capped and the model kept resident; everything else speaks
   * plain OpenAI-compatible HTTP.
   */
  private providerFor(src: { base: string; label: string }): AiProvider {
    if (src.label === "ollama") {
      return new OllamaNativeProvider(
        src.base.replace(/\/v1\/?$/, ""),
        this.numCtx(),
        this.keepAlive(),
      );
    }
    return new OpenAICompatibleProvider(src.base, this.apiKey(), src.label);
  }

  /**
   * The bundled llama.cpp server, when Neurion has set one up. Injected late to
   * avoid a circular import with the engine module.
   */
  private bundled: { isReady(): boolean; baseUrl(): string } | null = null;
  registerBundledEngine(engine: {
    isReady(): boolean;
    baseUrl(): string;
  }): void {
    this.bundled = engine;
    this.indexCache = null;
  }

  /** Every OpenAI-compatible engine we may talk to, in preference order. */
  private sources(): Array<{ base: string; label: string }> {
    const out: Array<{ base: string; label: string }> = [];
    if (this.ds4BaseUrl) out.push({ base: this.ds4BaseUrl, label: "ds4" });
    out.push({ base: this.baseUrl, label: "ollama" });
    const lms = this.lmStudioBaseUrl;
    if (lms && lms !== this.baseUrl) out.push({ base: lms, label: "lmstudio" });
    // Last: a user who already runs ollama or LM Studio keeps using their own
    // models; the bundled engine exists so that someone with neither is not
    // left talking to a labelled mock.
    if (this.bundled?.isReady())
      out.push({ base: this.bundled.baseUrl(), label: "neurion" });
    return out;
  }

  // model id -> base url. Rebuilt at most every INDEX_TTL_MS: this used to be
  // two uncached HTTP round trips on EVERY chat message (plus an 800 ms stall
  // whenever the engine was down).
  private static readonly INDEX_TTL_MS = 15_000;
  private indexCache: {
    at: number;
    map: Map<string, { base: string; label: string }>;
  } | null = null;

  private async modelIndex(): Promise<
    Map<string, { base: string; label: string }>
  > {
    const now = Date.now();
    if (
      this.indexCache &&
      now - this.indexCache.at < ProviderResolverService.INDEX_TTL_MS
    ) {
      return this.indexCache.map;
    }
    const map = new Map<string, { base: string; label: string }>();
    for (const src of this.sources()) {
      for (const id of await this.modelsOf(src.base)) {
        if (!map.has(id)) map.set(id, src); // first source wins on a name clash
      }
    }
    this.indexCache = { at: now, map };
    return map;
  }

  /** First installed vision-capable model (llava, moondream, …), or null. */
  async pickVisionModel(): Promise<string | null> {
    const models = await this.listModels();
    return (
      models.find((m) =>
        /llava|moondream|vision|minicpm-?v|bakllava|llama3\.2-vision/i.test(m),
      ) ?? null
    );
  }

  /** True if an OpenAI-compatible /models endpoint answers ok within a short timeout. */
  private async reachable(base: string): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 800);
      const res = await fetch(`${base}/models`, { signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async modelsOf(base: string): Promise<string[]> {
    try {
      const res = await fetch(`${base}/models`);
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: Array<{ id: string }> };
      return (json.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  }

  /** Every model served by any reachable engine (ds4 + ollama + LM Studio). */
  async listModels(): Promise<string[]> {
    return [...(await this.modelIndex()).keys()].sort();
  }

  /**
   * Pick the engine that will actually serve the request. When the user chose a
   * model, route to whichever engine has THAT model loaded — otherwise a model
   * the user picked from LM Studio would be sent to ollama and 404.
   */
  async resolveFallback(preferredModel?: string): Promise<ResolvedProvider> {
    const forced = this.config.get<string>("AI_PROVIDER_DEFAULT");
    const chatModel =
      this.config.get<string>("AI_DEFAULT_CHAT_MODEL") ?? "llama3.1:8b";

    if (forced === "mock" || this.config.get<string>("NODE_ENV") === "test") {
      return { provider: this.mock, model: "mock" };
    }

    const index = await this.modelIndex();

    // 1) The model the user actually picked, served by whoever has it.
    if (preferredModel) {
      const src = index.get(preferredModel);
      if (src) {
        return {
          provider: this.providerFor(src),
          model: preferredModel,
        };
      }
    }

    // 2) ds4 (quasi-frontier DeepSeek V4) when configured + reachable.
    const ds4 = this.ds4BaseUrl;
    if (ds4 && (await this.reachable(ds4))) {
      this.logger.log(
        `Fallback -> ds4 (DwarfStar) at ${ds4}, model ${this.ds4Model}`,
      );
      return {
        provider: new OpenAICompatibleProvider(ds4, this.apiKey(), "ds4"),
        model: this.ds4Model,
      };
    }

    // 3) The configured default if it exists anywhere, else the first REAL chat
    //    model (never hand back a hardcoded tag the user may not have installed).
    const configured = index.get(chatModel);
    if (configured) {
      return { provider: this.providerFor(configured), model: chatModel };
    }
    for (const [id, src] of index) {
      if (/embed|rerank|bge|clip/i.test(id)) continue;
      return { provider: this.providerFor(src), model: id };
    }
    const first = [...index.entries()][0];
    if (first) {
      return { provider: this.providerFor(first[1]), model: first[0] };
    }

    this.logger.error(
      "No AI provider reachable — using LABELED mock. Configure ollama (infra/scripts/setup-ollama.ps1), LM Studio (AI_LMSTUDIO_BASE_URL) or a ds4-server (AI_DS4_BASE_URL).",
    );
    return { provider: this.mock, model: "mock" };
  }
}
