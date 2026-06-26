import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderResolverService } from './provider-resolver.service';

@Controller('ai')
export class ModelsController {
  constructor(
    private readonly resolver: ProviderResolverService,
    private readonly config: ConfigService,
  ) {}

  @Get('models')
  async models() {
    return {
      models: await this.resolver.listModels(),
      chatDefault: this.config.get<string>('AI_DEFAULT_CHAT_MODEL') ?? null,
      agentDefault: this.config.get<string>('AI_AGENT_MODEL') ?? null,
    };
  }
}
