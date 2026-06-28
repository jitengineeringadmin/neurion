import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { ProviderResolverService } from './provider-resolver.service';

interface PullDto {
  name?: string;
}

// Curated small models that run well on a typical machine (LM-Studio-style picker).
const RECOMMENDED = [
  { name: 'qwen2.5:3b', label: 'Qwen 2.5 3B', size: '~1.9 GB', note: 'Best all-round small model' },
  { name: 'llama3.2:3b', label: 'Llama 3.2 3B', size: '~2.0 GB', note: 'Meta, fast + capable' },
  { name: 'gemma2:2b', label: 'Gemma 2 2B', size: '~1.6 GB', note: 'Smallest, lightest' },
  { name: 'qwen2.5-coder:3b', label: 'Qwen 2.5 Coder 3B', size: '~1.9 GB', note: 'For the agent / coding' },
  { name: 'phi3.5:3.8b', label: 'Phi 3.5', size: '~2.2 GB', note: 'Microsoft, strong reasoning' },
];

@Controller('ai')
export class ModelsController {
  constructor(
    private readonly resolver: ProviderResolverService,
    private readonly config: ConfigService,
  ) {}

  /** ollama native API base (strip the OpenAI-compat /v1 suffix). */
  private ollamaBase(): string {
    const b = this.config.get<string>('AI_OPENAI_COMPATIBLE_BASE_URL') ?? 'http://localhost:11434/v1';
    return b.replace(/\/v1\/?$/, '');
  }

  @Get('models')
  async models() {
    return {
      models: await this.resolver.listModels(),
      chatDefault: this.config.get<string>('AI_DEFAULT_CHAT_MODEL') ?? null,
      agentDefault: this.config.get<string>('AI_AGENT_MODEL') ?? null,
    };
  }

  @Get('models/recommended')
  recommended() {
    return { recommended: RECOMMENDED };
  }

  /** Models already downloaded locally + whether the local engine is reachable. */
  @Get('models/installed')
  async installed() {
    try {
      const res = await fetch(`${this.ollamaBase()}/api/tags`);
      if (!res.ok) return { engine: 'down', installed: [] };
      const json = (await res.json()) as { models?: Array<{ name: string; size?: number }> };
      const installed = (json.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size ?? null }));
      return { engine: 'up', installed };
    } catch {
      return { engine: 'down', installed: [] };
    }
  }

  /** Download a model with live progress (proxies ollama /api/pull as SSE). */
  @Post('models/pull')
  async pull(@Body() dto: PullDto, @Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const name = (dto.name ?? '').trim();
    if (!name) {
      send('error', { message: 'model name required' });
      return void res.end();
    }
    try {
      const r = await fetch(`${this.ollamaBase()}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, stream: true }),
      });
      if (!r.ok || !r.body) {
        send('error', { message: `engine HTTP ${r.status} — is the model name correct?` });
        return void res.end();
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          try {
            const p = JSON.parse(t) as { status?: string; total?: number; completed?: number; error?: string };
            if (p.error) {
              send('error', { message: p.error });
              return void res.end();
            }
            const percent = p.total && p.completed ? Math.round((p.completed / p.total) * 100) : null;
            send('progress', { status: p.status ?? '', total: p.total ?? null, completed: p.completed ?? null, percent });
          } catch {
            /* keep-alive / partial */
          }
        }
      }
      send('done', { name });
      res.end();
    } catch (e) {
      send('error', { message: (e as Error).message });
      res.end();
    }
  }
}
