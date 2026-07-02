import { Body, Controller, Delete, Get, Param, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { Response } from 'express';

interface GenDto { prompt?: string; negative?: string; steps?: number; width?: number; height?: number; seed?: number }
interface ModelDef {
  id: string; label: string; desc: string; url: string; file: string; sizeMb: number;
  sampler: string; cfg: number; steps: number; recommended?: boolean;
}
interface Active { source: 'curated' | 'custom'; id?: string; path: string; label: string; sampler: string; cfg: number; steps: number }

// stable-diffusion.cpp binary (win-vulkan auto-uses GPU + falls back to CPU; mac-arm64).
const SDCPP_TAG = 'master-741-484baa4';
const SDCPP_ZIP: Record<string, string> = {
  win32: 'sd-master-484baa4-bin-win-vulkan-x64.zip',
  darwin: 'sd-master-484baa4-bin-Darwin-macOS-15.7.7-arm64.zip',
};
const SDCPP_URL = (zip: string) => `https://github.com/leejet/stable-diffusion.cpp/releases/download/${SDCPP_TAG}/${zip}`;
const CLI = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';

// Curated image models the user can pick from (auto-downloaded). Each carries the
// sd.cpp params it wants (LCM/Turbo models need a specific sampler + low cfg + few steps).
const CURATED: ModelDef[] = [
  { id: 'sd15', label: 'Standard', desc: 'Balanced, fast, small', file: 'sd15.gguf', sizeMb: 1600,
    url: 'https://huggingface.co/second-state/stable-diffusion-v1-5-GGUF/resolve/main/stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf',
    sampler: 'euler', cfg: 7, steps: 20 },
  { id: 'dreamshaper', label: 'DreamShaper', desc: 'Nicer photos, still fast', file: 'dreamshaper.safetensors', sizeMb: 2000, recommended: true,
    url: 'https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper8_LCM.safetensors',
    sampler: 'lcm', cfg: 2, steps: 8 },
  { id: 'dreamshaper-xl', label: 'DreamShaper XL · high quality (heavy)', desc: 'Best quality, needs a strong GPU', file: 'dreamshaper-xl.safetensors', sizeMb: 6500,
    url: 'https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaperXL_Turbo_dpmppSdeKarras_half_pruned_6.safetensors',
    sampler: 'euler_a', cfg: 2, steps: 8 },
];
const byId = (id: string) => CURATED.find((m) => m.id === id) || null;
const NAME_RE = /^[^<>|?*"']+\.(safetensors|gguf|ckpt)$/i; // custom model path sanity

let setup = { installing: false, percent: 0, stage: '', modelId: '' };
let generating = false;

/**
 * Local text-to-image. A stable-diffusion.cpp engine + a user-chosen model are
 * downloaded on first use (no Docker/Python/external server). The user can pick from
 * curated models OR point at their own .safetensors/.gguf. See [[neurion-compute-control]].
 */
@Controller('ai/image')
export class ImageController {
  constructor(private readonly config: ConfigService) {}

  private dir(): string | null {
    return this.config.get<string>('NEURION_IMAGE_DIR') || process.env.NEURION_IMAGE_DIR || null;
  }
  private binPath(dir: string) { return path.join(dir, 'bin', CLI); }
  private binReady(dir: string) { return existsSync(this.binPath(dir)); }
  private modelPath(dir: string, file: string) { return path.join(dir, 'models', file); }
  private activePath(dir: string) { return path.join(dir, 'active.json'); }
  // A real, COMPLETE model file — not a 0-byte or partially-downloaded remnant. For
  // curated models, pass the expected size so a truncated file (interrupted download)
  // is not counted as installed and gets re-downloaded.
  private modelOk(p: string, minMb = 1): boolean { try { return existsSync(p) && statSync(p).size >= minMb * 1_000_000; } catch { return false; } }

  /** Current active model (migrates the pre-picker single model.gguf to 'sd15' if present). */
  private active(dir: string): Active | null {
    const ap = this.activePath(dir);
    if (existsSync(ap)) {
      try {
        const a = JSON.parse(readFileSync(ap, 'utf8')) as Active;
        if (this.modelOk(a.path)) return a;
      } catch { /* fall through */ }
    }
    const legacy = path.join(dir, 'model.gguf'); // pre-v1.5.1 setup wrote this
    if (existsSync(legacy)) {
      const m = byId('sd15')!;
      const a: Active = { source: 'curated', id: 'sd15', path: legacy, label: m.label, sampler: m.sampler, cfg: m.cfg, steps: m.steps };
      try { writeFileSync(ap, JSON.stringify(a)); } catch { /* best effort */ }
      return a;
    }
    return null;
  }

  @Get('status')
  status() {
    const dir = this.dir();
    if (!dir) return { engine: 'unavailable' as const };
    if (setup.installing) return { engine: 'installing' as const, percent: setup.percent, stage: setup.stage };
    const supported = process.platform === 'win32' || process.platform === 'darwin';
    if (!supported) return { engine: 'unsupported' as const };
    const a = this.active(dir);
    if (this.binReady(dir) && a) return { engine: 'ready' as const, model: { label: a.label, id: a.id ?? 'custom' } };
    return { engine: 'needs_setup' as const };
  }

  /** Curated model list + which is installed + the active one. */
  @Get('models')
  models() {
    const dir = this.dir();
    const a = dir ? this.active(dir) : null;
    return {
      bin: dir ? this.binReady(dir) : false,
      custom: process.platform === 'win32' || process.platform === 'darwin',
      active: a ? { id: a.id ?? 'custom', label: a.label, source: a.source } : null,
      models: CURATED.map((m) => ({
        id: m.id, label: m.label, desc: m.desc, sizeMb: m.sizeMb, recommended: !!m.recommended,
        installed: dir ? this.modelOk(this.modelPath(dir, m.file), m.sizeMb * 0.9) : false,
      })),
    };
  }

  /** Pick + activate a curated model (downloads the engine binary + the model as needed). SSE. */
  @Post('model/select')
  async selectModel(@Body() dto: { id?: string }, @Res() res: Response): Promise<void> {
    this.sse(res);
    const send = (e: string, d: unknown) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    const dir = this.dir();
    const m = byId(String(dto.id ?? ''));
    if (!dir) { send('error', { message: 'image engine not available' }); return void res.end(); }
    if (!m) { send('error', { message: 'unknown model' }); return void res.end(); }
    if (setup.installing) { send('error', { message: 'setup already in progress' }); return void res.end(); }

    setup = { installing: true, percent: 0, stage: 'engine', modelId: m.id };
    try {
      await this.ensureBin(dir, (pc) => { setup.percent = Math.round(pc * 0.05); setup.stage = 'engine'; send('progress', { percent: setup.percent, stage: 'engine' }); });
      const mp = this.modelPath(dir, m.file);
      if (!this.modelOk(mp, m.sizeMb * 0.9)) {
        mkdirSync(path.dirname(mp), { recursive: true });
        await this.download(m.url, mp, (pc) => { setup.percent = 5 + Math.round(pc * 0.95); setup.stage = 'model'; send('progress', { percent: setup.percent, stage: 'model' }); });
      }
      const a: Active = { source: 'curated', id: m.id, path: mp, label: m.label, sampler: m.sampler, cfg: m.cfg, steps: m.steps };
      writeFileSync(this.activePath(dir), JSON.stringify(a));
      setup = { installing: false, percent: 100, stage: 'done', modelId: '' };
      send('done', { ok: true });
    } catch (e) {
      setup = { installing: false, percent: 0, stage: '', modelId: '' };
      send('error', { message: (e as Error).message });
    }
    res.end();
  }

  /** Use a model file the user already has on disk (chosen via the desktop file picker). */
  @Post('model/custom')
  async customModel(@Body() dto: { path?: string; label?: string }) {
    const dir = this.dir();
    if (!dir) return { ok: false as const, error: 'image engine not available' };
    const p = (dto.path ?? '').trim();
    if (!p || !existsSync(p) || !NAME_RE.test(path.basename(p))) return { ok: false as const, error: 'pick a .safetensors, .gguf or .ckpt file' };
    if (!this.binReady(dir)) {
      try { await this.ensureBin(dir, () => undefined); } catch (e) { return { ok: false as const, error: (e as Error).message }; }
    }
    const a: Active = { source: 'custom', path: p, label: dto.label || path.basename(p), sampler: 'euler_a', cfg: 7, steps: 20 };
    writeFileSync(this.activePath(dir), JSON.stringify(a));
    return { ok: true as const, model: { id: 'custom', label: a.label } };
  }

  private galleryDir(dir: string) { return path.join(dir, 'gallery'); }

  /**
   * Start a generation and return its id immediately. The work runs server-side and
   * the result is saved to the gallery, so it KEEPS GOING (and is remembered) even if
   * the user navigates away — unlike the old page-bound sync call.
   */
  @Post()
  generate(@Body() dto: GenDto) {
    const prompt = (dto.prompt ?? '').trim();
    if (!prompt) return { ok: false as const, error: 'prompt required' };
    const dir = this.dir();
    if (!dir || !this.binReady(dir)) return { ok: false as const, error: 'image engine not ready — set up a model first' };
    const a = this.active(dir);
    if (!a) return { ok: false as const, error: 'no image model selected' };
    if (generating) return { ok: false as const, error: 'another image is generating — one at a time' };

    const id = randomUUID();
    const width = this.dim(dto.width, 512);
    const height = this.dim(dto.height, 512);
    const steps = this.clampInt(dto.steps, 1, 40, a.steps);
    // pick a concrete seed so it's known/reproducible (sd.cpp -1 = random but unreported)
    const seed = Number.isFinite(Number(dto.seed)) && Number(dto.seed) >= 0 ? Math.round(Number(dto.seed)) : Math.floor(Math.random() * 2_147_483_647);
    const gdir = this.galleryDir(dir);
    mkdirSync(gdir, { recursive: true });
    const meta = { id, prompt, negative: dto.negative ?? '', width, height, steps, seed, model: a.label, status: 'running' as string, ts: Date.now(), error: '' };
    writeFileSync(path.join(gdir, `${id}.json`), JSON.stringify(meta));

    const outPng = path.join(gdir, `${id}.png`);
    const args = [
      '-m', a.path, '-p', prompt,
      ...(dto.negative && dto.negative.trim() ? ['-n', dto.negative.trim()] : []),
      '--cfg-scale', String(a.cfg), '--steps', String(steps), '--sampling-method', a.sampler,
      '-W', String(width), '-H', String(height), '--seed', String(seed), '-o', outPng,
    ];
    generating = true;
    const finish = (status: string, error = '') => {
      generating = false;
      try { writeFileSync(path.join(gdir, `${id}.json`), JSON.stringify({ ...meta, status, error })); } catch { /* ignore */ }
    };
    const cp = spawn(this.binPath(dir), args, { cwd: path.join(dir, 'bin'), windowsHide: true });
    let err = '';
    cp.stderr.on('data', (d) => (err += d.toString()));
    const to = setTimeout(() => { cp.kill(); finish('failed', 'timed out'); }, 600000);
    cp.on('error', (e) => { clearTimeout(to); finish('failed', (e as Error).message); });
    cp.on('close', (code) => {
      clearTimeout(to);
      if (code === 0 && existsSync(outPng)) finish('done');
      else finish('failed', err.slice(-200) || `sd exited ${code}`);
    });
    return { ok: true as const, id };
  }

  /** Delete a generation from the gallery (meta + png). */
  @Delete('gallery/:id')
  deleteItem(@Param('id') id: string) {
    const dir = this.dir();
    if (!dir || !/^[a-f0-9-]{10,}$/i.test(id)) return { ok: false as const };
    const gdir = this.galleryDir(dir);
    rmSync(path.join(gdir, `${id}.json`), { force: true });
    rmSync(path.join(gdir, `${id}.png`), { force: true });
    return { ok: true as const };
  }

  /** Recent generations (newest first) — the persistent gallery / history. */
  @Get('gallery')
  gallery() {
    const dir = this.dir();
    if (!dir) return { items: [] as unknown[] };
    const gdir = this.galleryDir(dir);
    if (!existsSync(gdir)) return { items: [] as unknown[] };
    const metas = readdirSync(gdir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(readFileSync(path.join(gdir, f), 'utf8')) as Record<string, unknown>; } catch { return null; } })
      .filter((m): m is Record<string, unknown> => !!m)
      .sort((x, y) => (Number(y.ts) || 0) - (Number(x.ts) || 0))
      .slice(0, 24);
    const items = metas.map((m) => {
      const png = path.join(gdir, `${String(m.id)}.png`);
      const image = m.status === 'done' && existsSync(png) ? readFileSync(png).toString('base64') : undefined;
      return { id: m.id, prompt: m.prompt, status: m.status, seed: m.seed, ts: m.ts, error: m.error, model: m.model, image };
    });
    return { items };
  }

  // --- helpers ---
  private sse(res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.flushHeaders?.();
  }
  private async ensureBin(dir: string, onProgress: (pct: number) => void): Promise<void> {
    if (this.binReady(dir)) return;
    const zipName = SDCPP_ZIP[process.platform];
    if (!zipName) throw new Error(`image engine not supported on ${process.platform}`);
    const binDir = path.join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const zip = path.join(dir, 'engine.zip');
    await this.download(SDCPP_URL(zipName), zip, onProgress);
    new AdmZip(zip).extractAllTo(binDir, true);
    rmSync(zip, { force: true });
    if (!this.binReady(dir)) throw new Error('engine binary missing after extract');
  }
  // Atomic: stream to a .part file and only rename into place when complete, so an
  // interrupted download never leaves a truncated file that looks "installed".
  private async download(url: string, out: string, onProgress: (pct: number) => void): Promise<void> {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`download failed HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') || 0);
    let got = 0;
    const tmp = `${out}.part`;
    const rs = Readable.fromWeb(res.body as never);
    rs.on('data', (c: Buffer) => { got += c.length; if (total > 0) onProgress((got / total) * 100); });
    try {
      await pipeline(rs, createWriteStream(tmp));
      if (total > 0 && got < total * 0.99) throw new Error('download incomplete');
      rmSync(out, { force: true });
      renameSync(tmp, out);
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  }
  private clampInt(v: unknown, lo: number, hi: number, def: number): number {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  }
  private dim(v: unknown, def: number): number { return Math.round(this.clampInt(v, 256, 1024, def) / 64) * 64; }
}
