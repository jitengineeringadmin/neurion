import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider } from './providers/ai-provider.interface';
import { MockProvider } from './providers/mock.provider';
import { OpenAICompatibleProvider } from './providers/openai-compatible.provider';

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
    return this.config.get<string>('AI_OPENAI_COMPATIBLE_BASE_URL') ?? 'http://localhost:11434/v1';
  }

  /** ds4 / DwarfStar (antirez) — native DeepSeek V4 engine, OpenAI-compatible. Optional. */
  private get ds4BaseUrl(): string | undefined {
    return this.config.get<string>('AI_DS4_BASE_URL') || undefined;
  }
  private get ds4Model(): string {
    return this.config.get<string>('AI_DS4_MODEL') ?? 'deepseek-v4-flash';
  }
  private apiKey(): string {
    return this.config.get<string>('AI_OPENAI_COMPATIBLE_API_KEY') ?? 'local-dev';
  }

  /** A local OpenAI-compatible provider (ollama) — used for vision chat. */
  localProvider(): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider(this.baseUrl, this.apiKey());
  }

  /** First installed vision-capable model (llava, moondream, …), or null. */
  async pickVisionModel(): Promise<string | null> {
    const models = await this.listModels();
    return models.find((m) => /llava|moondream|vision|minicpm-?v|bakllava|llama3\.2-vision/i.test(m)) ?? null;
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

  /** Models from the ds4 endpoint (if configured) and the ollama endpoint, merged. */
  async listModels(): Promise<string[]> {
    const bases = this.ds4BaseUrl ? [this.ds4BaseUrl, this.baseUrl] : [this.baseUrl];
    const all = new Set<string>();
    for (const b of bases) for (const m of await this.modelsOf(b)) all.add(m);
    return [...all].sort();
  }

  async resolveFallback(): Promise<ResolvedProvider> {
    const forced = this.config.get<string>('AI_PROVIDER_DEFAULT');
    const chatModel = this.config.get<string>('AI_DEFAULT_CHAT_MODEL') ?? 'llama3.1:8b';

    if (forced === 'mock' || this.config.get<string>('NODE_ENV') === 'test') {
      return { provider: this.mock, model: 'mock' };
    }

    // Prefer ds4 (quasi-frontier DeepSeek V4) when a ds4-server is configured + reachable.
    const ds4 = this.ds4BaseUrl;
    if (ds4 && (await this.reachable(ds4))) {
      this.logger.log(`Fallback -> ds4 (DwarfStar) at ${ds4}, model ${this.ds4Model}`);
      return { provider: new OpenAICompatibleProvider(ds4, this.apiKey(), 'ds4'), model: this.ds4Model };
    }

    if (await this.reachable(this.baseUrl)) {
      // Don't hand back a hardcoded model the user may not have (llama3.1:8b → ollama
      // 404): if the configured default isn't installed, use the first REAL chat model.
      const installed = await this.modelsOf(this.baseUrl);
      let model = chatModel;
      if (installed.length > 0 && !installed.includes(chatModel)) {
        model = installed.find((m) => !/embed|rerank|bge|clip/i.test(m)) ?? installed[0] ?? chatModel;
      }
      return { provider: new OpenAICompatibleProvider(this.baseUrl, this.apiKey()), model };
    }

    this.logger.error('No AI provider reachable — using LABELED mock. Configure ollama (infra/scripts/setup-ollama.ps1) or a ds4-server (AI_DS4_BASE_URL).');
    return { provider: this.mock, model: 'mock' };
  }
}
