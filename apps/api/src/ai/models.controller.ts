import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { ProviderResolverService } from './provider-resolver.service';

interface PullDto {
  name?: string;
  quant?: string;
}

// Quantization variants the picker offers. The tag is appended to an ollama base
// name (e.g. qwen2.5:7b + q4_K_M -> qwen2.5:7b-q4_K_M). '' = whatever ollama ships
// by default (usually Q4_K_M). These tags exist for the qwen/llama/gemma families;
// if a specific model lacks one, the pull surfaces ollama's error to the user.
const QUANT_LEVELS: Array<{ tag: string; hint: string }> = [
  { tag: '', hint: 'default · balanced (~Q4)' },
  { tag: 'q4_K_M', hint: 'smallest, fastest, least memory' },
  { tag: 'q5_K_M', hint: 'balanced quality/size' },
  { tag: 'q6_K', hint: 'higher quality, bigger' },
  { tag: 'q8_0', hint: 'near-full quality, large' },
  { tag: 'fp16', hint: 'full precision, very large' },
];
const QUANT_TAGS = new Set(QUANT_LEVELS.map((q) => q.tag).filter(Boolean));
// ollama model name: family[/...][:tag] — letters, digits, . _ - / :
const NAME_RE = /^[a-zA-Z0-9][\w.\/-]*(:[\w.-]+)?$/;

// Curated models, grouped for an LM-Studio-style picker. `name` is the ollama tag.
const RECOMMENDED = [
  // Qwen 2.5 — general chat, 0.5B → 72B
  { name: 'qwen2.5:0.5b', label: 'Qwen 2.5 0.5B', size: '~0.4 GB', note: 'Tiny, runs on anything', group: 'Qwen 2.5' },
  { name: 'qwen2.5:1.5b', label: 'Qwen 2.5 1.5B', size: '~1.0 GB', note: 'Very light, fast', group: 'Qwen 2.5' },
  { name: 'qwen2.5:3b', label: 'Qwen 2.5 3B', size: '~1.9 GB', note: 'Best all-round small model', group: 'Qwen 2.5' },
  { name: 'qwen2.5:7b', label: 'Qwen 2.5 7B', size: '~4.7 GB', note: 'Strong, needs 8 GB+ RAM/VRAM', group: 'Qwen 2.5' },
  { name: 'qwen2.5:14b', label: 'Qwen 2.5 14B', size: '~9.0 GB', note: 'High quality, needs a GPU', group: 'Qwen 2.5' },
  { name: 'qwen2.5:32b', label: 'Qwen 2.5 32B', size: '~20 GB', note: 'Big, strong GPU only', group: 'Qwen 2.5' },
  { name: 'qwen2.5:72b', label: 'Qwen 2.5 72B', size: '~47 GB', note: 'Flagship, heavy hardware', group: 'Qwen 2.5' },
  // Qwen 2.5 Coder — coding / agent
  { name: 'qwen2.5-coder:0.5b', label: 'Qwen 2.5 Coder 0.5B', size: '~0.4 GB', note: 'Tiny coder', group: 'Qwen 2.5 Coder' },
  { name: 'qwen2.5-coder:1.5b', label: 'Qwen 2.5 Coder 1.5B', size: '~1.0 GB', note: 'Light coder', group: 'Qwen 2.5 Coder' },
  { name: 'qwen2.5-coder:3b', label: 'Qwen 2.5 Coder 3B', size: '~1.9 GB', note: 'For the agent / coding', group: 'Qwen 2.5 Coder' },
  { name: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B', size: '~4.7 GB', note: 'Strong coder', group: 'Qwen 2.5 Coder' },
  { name: 'qwen2.5-coder:14b', label: 'Qwen 2.5 Coder 14B', size: '~9.0 GB', note: 'High-quality coder, GPU', group: 'Qwen 2.5 Coder' },
  { name: 'qwen2.5-coder:32b', label: 'Qwen 2.5 Coder 32B', size: '~20 GB', note: 'Top coder, strong GPU', group: 'Qwen 2.5 Coder' },
  // Qwen 3 — latest generation
  { name: 'qwen3:0.6b', label: 'Qwen 3 0.6B', size: '~0.5 GB', note: 'Newest, tiny', group: 'Qwen 3' },
  { name: 'qwen3:1.7b', label: 'Qwen 3 1.7B', size: '~1.4 GB', note: 'Newest, light', group: 'Qwen 3' },
  { name: 'qwen3:4b', label: 'Qwen 3 4B', size: '~2.6 GB', note: 'Newest, balanced', group: 'Qwen 3' },
  { name: 'qwen3:8b', label: 'Qwen 3 8B', size: '~5.2 GB', note: 'Newest, strong', group: 'Qwen 3' },
  { name: 'qwen3:14b', label: 'Qwen 3 14B', size: '~9.3 GB', note: 'Newest, high quality, GPU', group: 'Qwen 3' },
  { name: 'qwen3:30b', label: 'Qwen 3 30B (MoE)', size: '~19 GB', note: 'Mixture-of-experts, fast for its size', group: 'Qwen 3' },
  { name: 'qwen3:32b', label: 'Qwen 3 32B', size: '~20 GB', note: 'Newest big, strong GPU', group: 'Qwen 3' },
  // Reasoning
  { name: 'qwq:32b', label: 'QwQ 32B', size: '~20 GB', note: 'Qwen reasoning model', group: 'Reasoning' },
  // Other families
  { name: 'llama3.2:3b', label: 'Llama 3.2 3B', size: '~2.0 GB', note: 'Meta, fast + capable', group: 'Other' },
  { name: 'gemma2:2b', label: 'Gemma 2 2B', size: '~1.6 GB', note: 'Google, smallest, lightest', group: 'Other' },
  { name: 'phi3.5:3.8b', label: 'Phi 3.5', size: '~2.2 GB', note: 'Microsoft, strong reasoning', group: 'Other' },
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
    return { recommended: RECOMMENDED, quants: QUANT_LEVELS };
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

    const base = (dto.name ?? '').trim();
    if (!base || !NAME_RE.test(base)) {
      send('error', { message: 'invalid model name' });
      return void res.end();
    }
    const quant = (dto.quant ?? '').trim();
    if (quant && !QUANT_TAGS.has(quant)) {
      send('error', { message: `unsupported quantization: ${quant}` });
      return void res.end();
    }
    // Append the quant as an ollama tag suffix on the base tag (qwen2.5:7b -> qwen2.5:7b-q4_K_M).
    const name = quant ? `${base}-${quant}` : base;
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
