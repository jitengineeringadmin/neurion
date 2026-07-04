import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { cpus, totalmem } from 'node:os';
import { ProviderResolverService } from './provider-resolver.service';

interface PullDto {
  name?: string;
  quant?: string;
}

// Quantization variants the picker offers. '' = whatever ollama ships by default.
// The real ollama tag is NOT base+quant — the variant infix differs per family
// (qwen3/qwq: {size}-{quant}; qwen2.5/coder, gemma2, llama3.2: {size}-instruct-{quant}).
// So resolveQuantTag() probes the ollama registry for the actual tag instead of guessing.
const QUANT_LEVELS: Array<{ tag: string; hint: string }> = [
  { tag: '', hint: 'default · balanced (~Q4)' },
  { tag: 'q4_K_M', hint: 'smallest, fastest, least memory' },
  { tag: 'q5_K_M', hint: 'balanced quality/size' },
  { tag: 'q6_K', hint: 'higher quality, bigger' },
  { tag: 'q8_0', hint: 'near-full quality, large' },
  { tag: 'fp16', hint: 'full precision, very large' },
];
const QUANT_TAGS = new Set(QUANT_LEVELS.map((q) => q.tag).filter(Boolean));
// Variant infixes tried (in order) between the size tag and the quant token.
const QUANT_INFIXES = ['', 'instruct'];
const OLLAMA_REGISTRY = 'https://registry.ollama.ai/v2/library';
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
  // DeepSeek R1 — reasoning (thinks step by step; great for hard problems, math, logic)
  { name: 'deepseek-r1:1.5b', label: 'DeepSeek R1 1.5B', size: '~1.1 GB', note: 'Reasoning, tiny', group: 'DeepSeek R1 · reasoning' },
  { name: 'deepseek-r1:7b', label: 'DeepSeek R1 7B', size: '~4.7 GB', note: 'Reasoning, balanced', group: 'DeepSeek R1 · reasoning' },
  { name: 'deepseek-r1:8b', label: 'DeepSeek R1 8B', size: '~4.9 GB', note: 'Reasoning, strong', group: 'DeepSeek R1 · reasoning' },
  { name: 'deepseek-r1:14b', label: 'DeepSeek R1 14B', size: '~9.0 GB', note: 'Reasoning, high quality, GPU', group: 'DeepSeek R1 · reasoning' },
  { name: 'deepseek-coder-v2:16b', label: 'DeepSeek Coder V2 16B', size: '~8.9 GB', note: 'Top-tier open coder (MoE)', group: 'DeepSeek R1 · reasoning' },
  { name: 'qwq:32b', label: 'QwQ 32B', size: '~20 GB', note: 'Qwen reasoning model, strong GPU', group: 'DeepSeek R1 · reasoning' },
  // Vision — chat that can SEE images you send
  { name: 'moondream:latest', label: 'Moondream 1.8B', size: '~1.7 GB', note: 'Tiny, sees images, runs on anything', group: 'Vision · sees images' },
  { name: 'llava:7b', label: 'LLaVA 7B', size: '~4.7 GB', note: 'Describes/answers about images', group: 'Vision · sees images' },
  { name: 'llava:13b', label: 'LLaVA 13B', size: '~8.0 GB', note: 'Better vision, needs a GPU', group: 'Vision · sees images' },
  { name: 'llama3.2-vision:11b', label: 'Llama 3.2 Vision 11B', size: '~7.9 GB', note: 'Meta vision, high quality, GPU', group: 'Vision · sees images' },
  // Gemma 3 — Google, newest
  { name: 'gemma3:1b', label: 'Gemma 3 1B', size: '~0.8 GB', note: 'Google, newest, tiny', group: 'Gemma 3' },
  { name: 'gemma3:4b', label: 'Gemma 3 4B', size: '~3.3 GB', note: 'Google, newest, balanced', group: 'Gemma 3' },
  { name: 'gemma3:12b', label: 'Gemma 3 12B', size: '~8.1 GB', note: 'Google, high quality, GPU', group: 'Gemma 3' },
  { name: 'gemma3:27b', label: 'Gemma 3 27B', size: '~17 GB', note: 'Google flagship, strong GPU', group: 'Gemma 3' },
  // Mistral
  { name: 'mistral:7b', label: 'Mistral 7B', size: '~4.1 GB', note: 'Popular, fast, capable', group: 'Mistral' },
  { name: 'mistral-nemo:12b', label: 'Mistral Nemo 12B', size: '~7.1 GB', note: 'Bigger context, high quality', group: 'Mistral' },
  // Other families
  { name: 'llama3.2:3b', label: 'Llama 3.2 3B', size: '~2.0 GB', note: 'Meta, fast + capable', group: 'Other' },
  { name: 'llama3.3:70b', label: 'Llama 3.3 70B', size: '~43 GB', note: 'Meta flagship, very heavy', group: 'Other' },
  { name: 'gemma2:2b', label: 'Gemma 2 2B', size: '~1.6 GB', note: 'Google, smallest, lightest', group: 'Other' },
  { name: 'phi3.5:3.8b', label: 'Phi 3.5', size: '~2.2 GB', note: 'Microsoft, strong reasoning', group: 'Other' },
  // Newest top picks (verified on ollama)
  { name: 'qwen3-coder:30b', label: 'Qwen 3 Coder 30B (MoE)', size: '~19 GB', note: 'Newest top open coder — fast for its size, strong GPU', group: 'Top coders · newest' },
  { name: 'codestral:22b', label: 'Codestral 22B', size: '~13 GB', note: 'Mistral code specialist, excellent for code', group: 'Top coders · newest' },
  { name: 'starcoder2:7b', label: 'StarCoder2 7B', size: '~4.0 GB', note: 'Code completion, 600+ languages', group: 'Top coders · newest' },
  { name: 'starcoder2:15b', label: 'StarCoder2 15B', size: '~9.1 GB', note: 'Stronger code completion, GPU', group: 'Top coders · newest' },
  { name: 'phi4:14b', label: 'Phi 4 14B', size: '~9.1 GB', note: 'Microsoft, excellent reasoning', group: 'Other' },
  { name: 'mistral-small:24b', label: 'Mistral Small 3 24B', size: '~14 GB', note: 'High quality all-round, GPU', group: 'Mistral' },
  { name: 'granite3.3:8b', label: 'Granite 3.3 8B', size: '~4.9 GB', note: 'IBM, business + coding', group: 'Other' },
  { name: 'command-r7b:latest', label: 'Command R7B', size: '~5.0 GB', note: 'Cohere, great for RAG / documents', group: 'Other' },
  { name: 'minicpm-v:8b', label: 'MiniCPM-V 8B', size: '~5.5 GB', note: 'Strong vision, sees images', group: 'Vision · sees images' },
  // Embedding — for search / RAG (not for chat)
  { name: 'nomic-embed-text:latest', label: 'Nomic Embed', size: '~0.3 GB', note: 'For search / document memory', group: 'Embedding · search' },
  { name: 'mxbai-embed-large:latest', label: 'MxBai Embed Large', size: '~0.7 GB', note: 'Higher-quality search embeddings', group: 'Embedding · search' },
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

  /**
   * Resolve a base model + quant token to the REAL ollama tag by probing the
   * registry, since the variant infix differs per family (e.g. qwen2.5 needs
   * `-instruct-` while qwen3 does not). Returns the full pull name, or null if
   * no variant of that quant exists for the model.
   */
  private async resolveQuantTag(base: string, quant: string): Promise<string | null> {
    const i = base.indexOf(':');
    const model = i >= 0 ? base.slice(0, i) : base;
    const sizeTag = i >= 0 ? base.slice(i + 1) : 'latest';
    if (model.includes('/')) return null; // only official library models are probeable
    for (const infix of QUANT_INFIXES) {
      const tag = infix ? `${sizeTag}-${infix}-${quant}` : `${sizeTag}-${quant}`;
      try {
        const r = await fetch(`${OLLAMA_REGISTRY}/${model}/manifests/${tag}`, {
          signal: AbortSignal.timeout(6000),
        });
        if (r.ok) return `${model}:${tag}`;
      } catch {
        /* network/timeout — try next infix */
      }
    }
    return null;
  }

  @Get('models')
  async models() {
    const models = await this.resolver.listModels();
    return {
      models,
      // Never null when models exist: without an env override, fall back to the first
      // installed CHAT model (embedding/rerank models filtered out) so a fresh user's
      // first message gets real inference, not the labeled mock.
      chatDefault: this.pickDefault(models, this.config.get<string>('AI_DEFAULT_CHAT_MODEL')),
      agentDefault: this.pickDefault(models, this.config.get<string>('AI_AGENT_MODEL')),
    };
  }

  private pickDefault(models: string[], preferred?: string): string | null {
    if (preferred && models.includes(preferred)) return preferred;
    const chatable = models.filter((m) => !/embed|rerank|bge|clip/i.test(m));
    return chatable[0] ?? models[0] ?? preferred ?? null;
  }

  @Get('models/recommended')
  recommended() {
    return { recommended: RECOMMENDED, quants: QUANT_LEVELS };
  }

  /**
   * Auto-pick the best default CHAT model for THIS machine's RAM, so a non-technical
   * user never has to answer "which model?". Conservative (RAM-based, so it runs even
   * on CPU); a GPU only makes the same pick faster. Used by the first-run wizard.
   */
  @Get('models/recommend')
  recommend() {
    const ramGb = Math.round(totalmem() / 1_073_741_824);
    const cores = cpus().length;
    // Largest Qwen 2.5 (best all-round family) that fits comfortably: a model needs
    // roughly ~2x its file size in RAM for weights + context + OS headroom.
    const tiers: Array<{ min: number; name: string }> = [
      { min: 48, name: 'qwen2.5:72b' },
      { min: 40, name: 'qwen2.5:32b' },
      { min: 20, name: 'qwen2.5:14b' },
      { min: 12, name: 'qwen2.5:7b' },
      { min: 7, name: 'qwen2.5:3b' },
      { min: 0, name: 'qwen2.5:1.5b' },
    ];
    const tier = (tiers.find((t) => ramGb >= t.min) ?? tiers[tiers.length - 1])!; // min:0 always matches
    const model = RECOMMENDED.find((m) => m.name === tier.name) ?? RECOMMENDED.find((m) => m.name === 'qwen2.5:3b')!;
    return { ramGb, cores, model };
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
    // Resolve the real ollama tag for the requested quant (the variant infix
    // differs per family); blind base+quant would 404 on the registry.
    let name = base;
    if (quant) {
      send('progress', { status: `resolving ${quant}…`, total: null, completed: null, percent: null });
      const resolved = await this.resolveQuantTag(base, quant);
      if (!resolved) {
        send('error', { message: `quantization ${quant} is not available for ${base}` });
        return void res.end();
      }
      name = resolved;
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
