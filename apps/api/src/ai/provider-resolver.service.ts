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

  private async ollamaReachable(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 800);
      const res = await fetch(`${this.baseUrl}/models`, { signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  async resolveFallback(): Promise<ResolvedProvider> {
    const forced = this.config.get<string>('AI_PROVIDER_DEFAULT');
    const chatModel = this.config.get<string>('AI_DEFAULT_CHAT_MODEL') ?? 'llama3.1:8b';

    if (forced === 'mock' || this.config.get<string>('NODE_ENV') === 'test') {
      return { provider: this.mock, model: 'mock' };
    }

    if (await this.ollamaReachable()) {
      const apiKey = this.config.get<string>('AI_OPENAI_COMPATIBLE_API_KEY') ?? 'local-dev';
      return { provider: new OpenAICompatibleProvider(this.baseUrl, apiKey), model: chatModel };
    }

    this.logger.error('No AI provider reachable — using LABELED mock. Configure ollama (infra/scripts/setup-ollama.ps1).');
    return { provider: this.mock, model: 'mock' };
  }
}
