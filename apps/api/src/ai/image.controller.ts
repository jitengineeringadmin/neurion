import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { Response } from 'express';

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
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const dim = (v: unknown, def: number): number => Math.round(clampInt(v, 256, 1024, def) / 64) * 64;

// Pinned stable-diffusion.cpp release + a small, complete SD 1.5 model (GGUF Q8).
// The win-vulkan build loads BOTH a Vulkan (GPU) and a CPU backend, so it runs on a
// GPU when present and falls back to CPU otherwise — one build works everywhere.
const SDCPP_TAG = 'master-741-484baa4';
const SDCPP_ZIP: Record<string, string> = {
  win32: 'sd-master-484baa4-bin-win-vulkan-x64.zip',
  darwin: 'sd-master-484baa4-bin-Darwin-macOS-15.7.7-arm64.zip',
};
const SDCPP_URL = (zip: string) => `https://github.com/leejet/stable-diffusion.cpp/releases/download/${SDCPP_TAG}/${zip}`;
const MODEL_URL = 'https://huggingface.co/second-state/stable-diffusion-v1-5-GGUF/resolve/main/stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf';
const CLI = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';

// In-process setup state (single desktop, one API).
let setup = { installing: false, percent: 0, stage: '', error: '' };
let generating = false;

/**
 * Local text-to-image, turnkey. The engine (a stable-diffusion.cpp binary + a small
 * model) is downloaded on first use into NEURION_IMAGE_DIR — no Docker, no Python, no
 * external server, nothing for the user to install. Falls back to an Automatic1111-
 * compatible server if AI_IMAGE_BASE_URL is set (power users). See [[neurion-compute-control]].
 */
@Controller('ai/image')
export class ImageController {
  constructor(private readonly config: ConfigService) {}

  private dir(): string | null {
    return this.config.get<string>('NEURION_IMAGE_DIR') || process.env.NEURION_IMAGE_DIR || null;
  }
  private a1111(): string | null {
    return this.config.get<string>('AI_IMAGE_BASE_URL') || process.env.AI_IMAGE_BASE_URL || null;
  }
  private paths(dir: string) {
    return { bin: path.join(dir, 'bin', CLI), binDir: path.join(dir, 'bin'), model: path.join(dir, 'model.gguf') };
  }
  private ready(dir: string): boolean {
    const p = this.paths(dir);
    return existsSync(p.bin) && existsSync(p.model);
  }

  @Get('status')
  async status() {
    const dir = this.dir();
    // A1111 fallback (power users): report reachability like before.
    if (this.a1111()) {
      try {
        const res = await fetch(`${this.a1111()!.replace(/\/$/, '')}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(3000) });
        return { engine: res.ok ? ('ready' as const) : ('a1111_down' as const), backend: 'a1111' };
      } catch {
        return { engine: 'a1111_down' as const, backend: 'a1111' };
      }
    }
    if (!dir) return { engine: 'unavailable' as const, backend: 'local' }; // online build, no local engine dir
    if (setup.installing) return { engine: 'installing' as const, backend: 'local', percent: setup.percent, stage: setup.stage };
    if (this.ready(dir)) return { engine: 'ready' as const, backend: 'local' };
    const supported = process.platform === 'win32' || process.platform === 'darwin';
    return { engine: supported ? ('needs_setup' as const) : ('unsupported' as const), backend: 'local', sizeMb: 1800 };
  }

  /** One-time engine install: download the sd.cpp binary + model into NEURION_IMAGE_DIR (SSE progress). */
  @Post('setup')
  async setupEngine(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const dir = this.dir();
    if (!dir) { send('error', { message: 'image engine not available in this build' }); return void res.end(); }
    if (this.ready(dir)) { send('done', { already: true }); return void res.end(); }
    if (setup.installing) { send('error', { message: 'setup already in progress' }); return void res.end(); }
    const zipName = SDCPP_ZIP[process.platform];
    if (!zipName) { send('error', { message: `image engine not supported on ${process.platform} yet` }); return void res.end(); }

    setup = { installing: true, percent: 0, stage: 'engine', error: '' };
    const p = this.paths(dir);
    try {
      mkdirSync(p.binDir, { recursive: true });
      // 1) sd.cpp binary (small, 0-8%)
      const zipPath = path.join(dir, 'engine.zip');
      await this.download(SDCPP_URL(zipName), zipPath, (pc) => {
        setup.percent = Math.round(pc * 0.08); setup.stage = 'engine';
        send('progress', { percent: setup.percent, stage: 'engine' });
      });
      new AdmZip(zipPath).extractAllTo(p.binDir, true);
      rmSync(zipPath, { force: true });
      // 2) model (8-100%)
      setup.stage = 'model';
      await this.download(MODEL_URL, p.model, (pc) => {
        setup.percent = 8 + Math.round(pc * 0.92); setup.stage = 'model';
        send('progress', { percent: setup.percent, stage: 'model' });
      });
      if (!this.ready(dir)) throw new Error('engine files missing after download');
      setup = { installing: false, percent: 100, stage: 'done', error: '' };
      send('done', { ok: true });
    } catch (e) {
      setup = { installing: false, percent: 0, stage: '', error: (e as Error).message };
      try { rmSync(p.model, { force: true }); } catch { /* ignore */ }
      send('error', { message: (e as Error).message });
    }
    res.end();
  }

  private async download(url: string, out: string, onProgress: (pct: number) => void): Promise<void> {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`download failed HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') || 0);
    let got = 0;
    const rs = Readable.fromWeb(res.body as never);
    rs.on('data', (c: Buffer) => {
      got += c.length;
      if (total > 0) onProgress((got / total) * 100);
    });
    await pipeline(rs, createWriteStream(out));
  }

  /** Generate an image → base64 PNG. Uses the local sd.cpp engine, or the A1111 fallback. */
  @Post()
  async generate(@Body() dto: GenDto) {
    const prompt = (dto.prompt ?? '').trim();
    if (!prompt) return { ok: false as const, error: 'prompt required' };
    const width = dim(dto.width, 512);
    const height = dim(dto.height, 512);
    const steps = clampInt(dto.steps, 1, 40, 20);
    const seed = Number.isFinite(Number(dto.seed)) ? Math.round(Number(dto.seed)) : -1;

    if (this.a1111()) return this.generateA1111(prompt, dto.negative ?? '', width, height, steps, seed);

    const dir = this.dir();
    if (!dir || !this.ready(dir)) return { ok: false as const, error: 'image engine not ready — run setup first' };
    if (generating) return { ok: false as const, error: 'another image is generating — one at a time' };

    const p = this.paths(dir);
    const outPng = path.join(dir, `out-${randomUUID()}.png`);
    const args = [
      '-m', p.model, '-p', prompt,
      ...(dto.negative && dto.negative.trim() ? ['-n', dto.negative.trim()] : []),
      '--cfg-scale', '7', '--steps', String(steps),
      '-W', String(width), '-H', String(height),
      '--seed', String(seed), '-o', outPng,
    ];
    generating = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const cp = spawn(p.bin, args, { cwd: p.binDir, windowsHide: true });
        let err = '';
        cp.stderr.on('data', (d) => (err += d.toString()));
        const to = setTimeout(() => { cp.kill(); reject(new Error('generation timed out')); }, 600000);
        cp.on('error', (e) => { clearTimeout(to); reject(e); });
        cp.on('close', (code) => { clearTimeout(to); code === 0 ? resolve() : reject(new Error(err.slice(-300) || `sd exited ${code}`)); });
      });
      if (!existsSync(outPng)) return { ok: false as const, error: 'no image produced' };
      const image = readFileSync(outPng).toString('base64');
      return { ok: true as const, image, width, height, seed };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    } finally {
      generating = false;
      try { rmSync(outPng, { force: true }); } catch { /* ignore */ }
    }
  }

  private async generateA1111(prompt: string, negative: string, width: number, height: number, steps: number, seed: number) {
    try {
      const res = await fetch(`${this.a1111()!.replace(/\/$/, '')}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, negative_prompt: negative, steps, width, height, seed, cfg_scale: 7, sampler_name: 'Euler a' }),
        signal: AbortSignal.timeout(600000),
      });
      if (!res.ok) return { ok: false as const, error: `image engine HTTP ${res.status}` };
      const json = (await res.json()) as { images?: string[] };
      const image = json.images?.[0];
      return image ? { ok: true as const, image, width, height, seed } : { ok: false as const, error: 'engine returned no image' };
    } catch (e) {
      return { ok: false as const, error: (e as Error).name === 'TimeoutError' ? 'generation timed out' : 'image engine unreachable' };
    }
  }
}
