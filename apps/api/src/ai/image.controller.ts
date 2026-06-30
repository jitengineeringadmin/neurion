import { Body, Controller, Get, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface GenDto {
  prompt?: string;
  negative?: string;
  steps?: number;
  width?: number;
  height?: number;
  seed?: number;
}

const clampInt = (v: unknown, lo: number, hi: number, def: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};
// round to the nearest multiple of 64 within [256, 1024] (SD wants /64 dims)
const dim = (v: unknown, def: number): number => {
  const n = clampInt(v, 256, 1024, def);
  return Math.round(n / 64) * 64;
};

/**
 * Local image generation (Phase 1, "use my PC" half). Calls a local
 * Automatic1111 / Forge / SD.Next-compatible server (the de-facto `/sdapi/v1`
 * API), mirroring how chat uses a local ollama. The user runs the SD server and
 * points Neurion at it via AI_IMAGE_BASE_URL. Returns a base64 PNG (no S3 for the
 * MVP — images are small). Phase 2 will route the same endpoint to a GRID
 * image-worker when network nodes are available.
 */
@Controller('ai/image')
export class ImageController {
  constructor(private readonly config: ConfigService) {}

  private base(): string {
    return (this.config.get<string>('AI_IMAGE_BASE_URL') ?? 'http://localhost:7860').replace(/\/$/, '');
  }

  /** Is a local image engine reachable? Also returns the loaded model, if any. */
  @Get('status')
  async status() {
    try {
      const res = await fetch(`${this.base()}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return { engine: 'down' as const, models: [] as string[] };
      const json = (await res.json()) as Array<{ model_name?: string; title?: string }>;
      const models = json.map((m) => m.model_name ?? m.title ?? '').filter(Boolean);
      return { engine: 'up' as const, models };
    } catch {
      return { engine: 'down' as const, models: [] as string[] };
    }
  }

  /** Generate an image from a text prompt. Returns { image: base64-png }. */
  @Post()
  async generate(@Body() dto: GenDto) {
    const prompt = (dto.prompt ?? '').trim();
    if (!prompt) return { ok: false as const, error: 'prompt required' };

    const body = {
      prompt,
      negative_prompt: (dto.negative ?? '').trim(),
      steps: clampInt(dto.steps, 1, 60, 20),
      width: dim(dto.width, 512),
      height: dim(dto.height, 512),
      seed: Number.isFinite(Number(dto.seed)) ? Math.round(Number(dto.seed)) : -1,
      cfg_scale: 7,
      sampler_name: 'Euler a',
    };

    try {
      // CPU generation can take minutes — allow a generous ceiling.
      const res = await fetch(`${this.base()}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600000),
      });
      if (!res.ok) {
        if (res.status === 404) return { ok: false as const, error: 'no image engine — start a local SD server (Automatic1111 / Forge)' };
        return { ok: false as const, error: `image engine HTTP ${res.status}` };
      }
      const json = (await res.json()) as { images?: string[] };
      const image = json.images?.[0];
      if (!image) return { ok: false as const, error: 'engine returned no image' };
      return { ok: true as const, image, width: body.width, height: body.height, seed: body.seed };
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? 'generation timed out' : 'no image engine reachable';
      return { ok: false as const, error: msg };
    }
  }
}
