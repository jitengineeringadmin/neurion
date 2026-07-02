import { Body, Controller, Delete, Get, Param, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Video (beta) — an animated clip assembled LOCALLY from AI-generated keyframes:
 * N frames from the same sd.cpp engine the image page uses (active model), then
 * ffmpeg Ken-Burns zoom/pan + crossfades → a real ~10s MP4. Honest scope: this is a
 * cinematic animated sequence, not text-to-video AI — that needs GPU nodes (video.v1,
 * future GRID lane). ffmpeg is turnkey like the image engine: system ffmpeg if
 * present, else one-time download (BtbN build) into NEURION_IMAGE_DIR/ffbin.
 */

const CLI = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
const FF = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const FF_ZIP_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const FRAMES = 4; // keyframes per clip
const CLIP_S = 3; // seconds per keyframe
const FADE_S = 0.7; // crossfade

// True text-to-video (experimental): Wan 2.1 1.3B via sd.cpp `-M vid_gen`, with system
// RAM standing in for VRAM (quantized weights). Slow on consumer hardware by design —
// the requirements gate warns below MIN_RAM_GB/MIN_DISK_GB instead of failing cryptically.
const AI_FILES: { file: string; url: string; sizeMb: number }[] = [
  { file: 'wan2.1-t2v-1.3b.safetensors', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors', sizeMb: 2700 },
  { file: 'umt5-xxl-q5.gguf', url: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q5_K_M.gguf', sizeMb: 4000 },
  { file: 'wan_2.1_vae.safetensors', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors', sizeMb: 254 },
];
const MIN_RAM_GB = 16;
const MIN_DISK_GB = 12;
const AI_FRAMES = 33; // ~2s at 16 fps (Wan native)
const AI_FPS = 16;

interface Active { source: string; id?: string; path: string; label: string; sampler: string; cfg: number; steps: number }

class VideoDto {
  @IsString()
  @MaxLength(2000)
  prompt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  negative?: string;

  // 'clip' (default): keyframes + Ken-Burns montage. 'ai': true text-to-video (Wan).
  @IsOptional()
  @IsString()
  @MaxLength(10)
  mode?: 'clip' | 'ai';
}

let busy = false; // one clip at a time (frames hit the same GPU as images)

@Controller('ai/video')
export class VideoController {
  constructor(private readonly config: ConfigService) {}

  private dir(): string | null {
    return this.config.get<string>('NEURION_IMAGE_DIR') || process.env.NEURION_IMAGE_DIR || null;
  }
  private sdBin(dir: string) { return path.join(dir, 'bin', CLI); }
  private galleryDir(dir: string) { return path.join(dir, 'gallery'); }
  private ffLocal(dir: string) { return path.join(dir, 'ffbin', FF); }

  private active(dir: string): Active | null {
    try {
      const a = JSON.parse(readFileSync(path.join(dir, 'active.json'), 'utf8')) as Active;
      return existsSync(a.path) && statSync(a.path).size > 1_000_000 ? a : null;
    } catch { return null; }
  }

  private aiDir(dir: string) { return path.join(dir, 'video-models'); }
  private aiPath(dir: string, file: string) { return path.join(this.aiDir(dir), file); }
  private aiInstalled(dir: string): boolean {
    return AI_FILES.every((f) => {
      try { return statSync(this.aiPath(dir, f.file)).size >= f.sizeMb * 1_000_000 * 0.9; } catch { return false; }
    });
  }
  /** Hardware gate for true text-to-video: RAM stands in for VRAM, disk for the bundle. */
  private requirements(dir: string) {
    const ramGb = Math.round(totalmem() / 1_073_741_824);
    let freeDiskGb = -1;
    try { const s = statfsSync(dir); freeDiskGb = Math.round((s.bavail * s.bsize) / 1_073_741_824); } catch { /* unknown */ }
    return { ramGb, freeDiskGb, minRamGb: MIN_RAM_GB, minDiskGb: MIN_DISK_GB, ramOk: ramGb >= MIN_RAM_GB, diskOk: freeDiskGb < 0 || freeDiskGb >= MIN_DISK_GB };
  }

  /** AI-video bundle state + hardware requirements (the FE shows a minimum-specs warning). */
  @Get('models')
  models() {
    const dir = this.dir();
    if (!dir) return { aiInstalled: false, files: [], requirements: null };
    return {
      aiInstalled: this.aiInstalled(dir),
      files: AI_FILES.map((f) => ({ file: f.file, sizeMb: f.sizeMb, installed: (() => { try { return statSync(this.aiPath(dir, f.file)).size >= f.sizeMb * 1_000_000 * 0.9; } catch { return false; } })() })),
      requirements: this.requirements(dir),
    };
  }

  /** One-time AI-video bundle download (~6.7GB, SSE progress weighted by file size). */
  @Post('model/setup-ai')
  async setupAi(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ } };
    const dir = this.dir();
    if (!dir) { send('error', { message: 'video engine unavailable in this deployment' }); return res.end(); }
    try {
      mkdirSync(this.aiDir(dir), { recursive: true });
      const totalMb = AI_FILES.reduce((s, f) => s + f.sizeMb, 0);
      let doneMb = 0;
      for (const f of AI_FILES) {
        const out = this.aiPath(dir, f.file);
        const ok = (() => { try { return statSync(out).size >= f.sizeMb * 1_000_000 * 0.9; } catch { return false; } })();
        if (!ok) {
          send('progress', { stage: f.file, percent: Math.round((doneMb / totalMb) * 100) });
          await this.download(f.url, out, (pct) => send('progress', { stage: f.file, percent: Math.round(((doneMb + (f.sizeMb * pct) / 100) / totalMb) * 100) }));
        }
        doneMb += f.sizeMb;
        send('progress', { stage: f.file, percent: Math.round((doneMb / totalMb) * 100) });
      }
      send('done', { ok: true });
    } catch (e) {
      send('error', { message: (e as Error).message });
    }
    res.end();
  }

  /** System ffmpeg if available, else the downloaded one, else null. */
  private ffmpeg(dir: string): string | null {
    const local = this.ffLocal(dir);
    if (existsSync(local)) return local;
    try {
      const r = spawnSync(FF.replace('.exe', ''), ['-version'], { windowsHide: true, timeout: 4000 });
      if (r.status === 0) return FF.replace('.exe', '');
    } catch { /* not in PATH */ }
    return null;
  }

  @Get('status')
  status() {
    const dir = this.dir();
    if (!dir) return { status: 'unavailable' as const };
    if (!existsSync(this.sdBin(dir)) || !this.active(dir)) return { status: 'engine_missing' as const };
    if (!this.ffmpeg(dir)) return { status: process.platform === 'win32' ? ('needs_setup' as const) : ('unsupported' as const) };
    return { status: busy ? ('generating' as const) : ('ready' as const) };
  }

  /** One-time ffmpeg download (SSE progress) — Windows build, ~170MB zip, extracts one exe. */
  @Post('setup')
  async setup(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ } };
    const dir = this.dir();
    if (!dir) { send('error', { message: 'video engine unavailable in this deployment' }); return res.end(); }
    if (process.platform !== 'win32') { send('error', { message: 'install ffmpeg (e.g. brew install ffmpeg) and retry' }); return res.end(); }
    try {
      const zipPath = path.join(dir, 'ffmpeg-dl.zip');
      mkdirSync(path.join(dir, 'ffbin'), { recursive: true });
      send('progress', { stage: 'download', percent: 0 });
      await this.download(FF_ZIP_URL, zipPath, (pct) => send('progress', { stage: 'download', percent: Math.round(pct) }));
      send('progress', { stage: 'extract', percent: 100 });
      // pull just ffmpeg.exe out of the zip (nested under <build>/bin/)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const entry = zip.getEntries().find((e: { entryName: string }) => e.entryName.endsWith('/bin/ffmpeg.exe'));
      if (!entry) throw new Error('ffmpeg.exe not found in the archive');
      writeFileSync(this.ffLocal(dir), entry.getData());
      rmSync(zipPath, { force: true });
      send('done', { ok: true });
    } catch (e) {
      send('error', { message: (e as Error).message });
    }
    res.end();
  }

  /** Start a clip (async): N keyframes with the active image model, then ffmpeg assembles. */
  @Post()
  generate(@Body() dto: VideoDto) {
    const prompt = (dto.prompt ?? '').trim();
    if (!prompt) return { ok: false as const, error: 'prompt required' };
    const dir = this.dir();
    if (!dir || !existsSync(this.sdBin(dir))) return { ok: false as const, error: 'image engine not ready — set up a model first' };
    const a = this.active(dir);
    if (dto.mode !== 'ai' && !a) return { ok: false as const, error: 'no image model selected' };
    const ff = this.ffmpeg(dir);
    if (!ff) return { ok: false as const, error: 'video engine not set up' };
    if (busy) return { ok: false as const, error: 'another video is generating — one at a time' };

    const ai = dto.mode === 'ai';
    if (ai) {
      if (!this.aiInstalled(dir)) return { ok: false as const, error: 'AI video model not installed' };
      const req = this.requirements(dir);
      if (!req.ramOk) return { ok: false as const, error: `minimum requirements not met: ${req.ramGb}GB RAM (need ${MIN_RAM_GB}GB+)` };
    }

    const id = randomUUID();
    const gdir = this.galleryDir(dir);
    mkdirSync(gdir, { recursive: true });
    const meta: Record<string, unknown> = { id, kind: 'video', ai, prompt, model: ai ? 'Wan 2.1' : a?.label ?? '', status: 'running', progress: ai ? 'ai' : '0/' + FRAMES, ts: Date.now(), error: '' };
    const save = () => { try { writeFileSync(path.join(gdir, `${id}.json`), JSON.stringify(meta)); } catch { /* ignore */ } };
    save();
    busy = true;
    const work = ai
      ? this.renderAi(dir, ff, id, prompt, (dto.negative ?? '').trim(), meta, save)
      : this.render(dir, ff, a as Active, id, prompt, (dto.negative ?? '').trim(), meta, save);
    void work.finally(() => { busy = false; });
    return { ok: true as const, id };
  }

  /** True text-to-video: sd.cpp vid_gen (Wan 2.1 1.3B) → PNG frames → ffmpeg → MP4. */
  private async renderAi(dir: string, ff: string, id: string, prompt: string, negative: string, meta: Record<string, unknown>, save: () => void): Promise<void> {
    const gdir = this.galleryDir(dir);
    const tmp = path.join(gdir, `${id}-frames`);
    mkdirSync(tmp, { recursive: true });
    try {
      // Flags proven on a 4GB-shared iGPU (2026-07-02): --offload-to-cpu streams the
      // diffusion weights RAM→GPU per-chunk ("RAM as virtual VRAM"); the 4GB text
      // encoder and the VRAM-hungry Wan VAE run on CPU. 9f/12st smoke = ~9 min.
      const args = [
        '-M', 'vid_gen',
        '--diffusion-model', this.aiPath(dir, 'wan2.1-t2v-1.3b.safetensors'),
        '--vae', this.aiPath(dir, 'wan_2.1_vae.safetensors'),
        '--t5xxl', this.aiPath(dir, 'umt5-xxl-q5.gguf'),
        '--offload-to-cpu', '--backend', 'te=cpu,vae=cpu',
        '-p', prompt,
        ...(negative ? ['-n', negative] : []),
        '--cfg-scale', '6.0', '--sampling-method', 'euler', '--steps', '15',
        '-W', '480', '-H', '480', '--video-frames', String(AI_FRAMES), '--flow-shift', '3.0',
        '--diffusion-fa', '-o', path.join(tmp, 'out.avi'),
      ];
      // hours-scale on CPU-class hardware — sd.cpp prints "|====| cur/tot - Xs/it"
      // sampling lines; surface them as REAL progress (step + ETA) instead of a blind
      // spinner. Saved throttled (only when the step advances).
      let lastStep = -1;
      await this.run(this.sdBin(dir), args, path.join(dir, 'bin'), 3 * 3600 * 1000, (line) => {
        const m = line.match(/\|\s*(\d+)\/(\d+)\s*-\s*([\d.]+)\s*(s\/it|it\/s)/);
        if (!m) return;
        const cur = Number(m[1]), tot = Number(m[2]);
        const rate = Number(m[3]);
        const secPerIt = m[4] === 's/it' ? rate : rate > 0 ? 1 / rate : 0;
        if (cur !== lastStep && tot > 0) {
          lastStep = cur;
          meta.progress = `s${cur}/${tot}`;
          meta.etaS = Math.round(Math.max(0, tot - cur) * secPerIt);
          save();
        }
      });
      meta.progress = 'montage'; delete meta.etaS; save();
      const outMp4 = path.join(gdir, `${id}.mp4`);
      // vid_gen saves an MJPEG .avi — transcode to a web-playable MP4. (Fallback: some
      // builds emit PNG frames instead.)
      const avi = readdirSync(tmp).find((f) => f.endsWith('.avi'));
      if (avi) {
        await this.run(ff, ['-i', path.join(tmp, avi), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', outMp4], gdir, 600000);
      } else {
        const frames = readdirSync(tmp).filter((f) => f.endsWith('.png')).sort((a, b) => {
          const na = Number((a.match(/(\d+)/) || [0, 0])[1]);
          const nb = Number((b.match(/(\d+)/) || [0, 0])[1]);
          return na - nb || a.localeCompare(b);
        });
        if (frames.length < 2) throw new Error('vid_gen produced no video');
        frames.forEach((f, i) => renameSync(path.join(tmp, f), path.join(tmp, `fr${String(i).padStart(4, '0')}.png`)));
        await this.run(ff, ['-framerate', String(AI_FPS), '-i', path.join(tmp, 'fr%04d.png'), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', outMp4], gdir, 600000);
      }
      if (!existsSync(outMp4) || statSync(outMp4).size < 10_000) throw new Error('ffmpeg produced no output');
      meta.status = 'done'; meta.progress = ''; save();
    } catch (e) {
      meta.status = 'failed'; meta.error = String((e as Error).message).slice(-200); save();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async render(dir: string, ff: string, a: Active, id: string, prompt: string, negative: string, meta: Record<string, unknown>, save: () => void): Promise<void> {
    const gdir = this.galleryDir(dir);
    const tmp = path.join(gdir, `${id}-frames`);
    mkdirSync(tmp, { recursive: true });
    try {
      // 1) keyframes — same prompt, different seeds (variations on the theme)
      for (let i = 0; i < FRAMES; i++) {
        meta.progress = `${i}/${FRAMES}`; save();
        const seed = Math.floor(Math.random() * 2_147_483_647);
        const frame = path.join(tmp, `f${i}.png`);
        const args = [
          '-m', a.path, '-p', prompt,
          ...(negative ? ['-n', negative] : []),
          '--cfg-scale', String(a.cfg), '--steps', String(a.steps), '--sampling-method', a.sampler,
          '-W', '512', '-H', '512', '--seed', String(seed), '-o', frame,
        ];
        await this.run(this.sdBin(dir), args, path.join(dir, 'bin'), 600000);
        if (!existsSync(frame)) throw new Error(`frame ${i + 1} failed`);
      }
      // 2) assemble — Ken Burns (alternating zoom in/out) + crossfades
      meta.progress = 'montage'; save();
      const fps = 30, d = CLIP_S * fps;
      const zooms: string[] = [];
      for (let i = 0; i < FRAMES; i++) {
        const z = i % 2 === 0 ? `min(1+0.0028*on,1.25)` : `max(1.25-0.0028*on,1.0)`;
        zooms.push(`[${i}:v]scale=2048:2048:flags=lanczos,zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${d}:s=720x720:fps=${fps},setsar=1[v${i}]`);
      }
      const xf: string[] = [];
      let prev = 'v0';
      for (let i = 1; i < FRAMES; i++) {
        const out = i === FRAMES - 1 ? 'vout' : `x${i}`;
        const offset = (CLIP_S - FADE_S) * i;
        xf.push(`[${prev}][v${i}]xfade=transition=fade:duration=${FADE_S}:offset=${offset.toFixed(2)}[${out}]`);
        prev = out;
      }
      const outMp4 = path.join(gdir, `${id}.mp4`);
      const ffArgs = [
        ...Array.from({ length: FRAMES }, (_, i) => ['-i', path.join(tmp, `f${i}.png`)]).flat(),
        '-filter_complex', [...zooms, ...xf].join(';'),
        '-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', outMp4,
      ];
      await this.run(ff, ffArgs, gdir, 300000);
      if (!existsSync(outMp4) || statSync(outMp4).size < 10_000) throw new Error('ffmpeg produced no output');
      meta.status = 'done'; meta.progress = ''; save();
    } catch (e) {
      meta.status = 'failed'; meta.error = String((e as Error).message).slice(-200); save();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  private run(bin: string, args: string[], cwd: string, timeoutMs: number, onLine?: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const cp = spawn(bin, args, { cwd, windowsHide: true });
      let err = '';
      const feed = (d: Buffer) => { if (onLine) for (const l of d.toString().split(/[\r\n]+/)) if (l) onLine(l); };
      cp.stdout.on('data', feed);
      cp.stderr.on('data', (d) => { feed(d); err += d.toString(); if (err.length > 8000) err = err.slice(-4000); });
      const to = setTimeout(() => { cp.kill(); reject(new Error('timed out')); }, timeoutMs);
      cp.on('error', (e) => { clearTimeout(to); reject(e); });
      cp.on('close', (code) => { clearTimeout(to); code === 0 ? resolve() : reject(new Error(err.slice(-200) || `exited ${code}`)); });
    });
  }

  /** Video history (metadata only — the MP4 streams via /file/:id). */
  @Get('gallery')
  gallery() {
    const dir = this.dir();
    if (!dir) return { items: [] as unknown[] };
    const gdir = this.galleryDir(dir);
    if (!existsSync(gdir)) return { items: [] as unknown[] };
    const items = readdirSync(gdir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(readFileSync(path.join(gdir, f), 'utf8')) as Record<string, unknown>; } catch { return null; } })
      .filter((m): m is Record<string, unknown> => !!m && m.kind === 'video')
      .sort((x, y) => (Number(y.ts) || 0) - (Number(x.ts) || 0))
      .slice(0, 40);
    return { items };
  }

  /** Delete a clip from the gallery (meta + mp4 + any leftover frames dir). */
  @Delete('gallery/:id')
  deleteItem(@Param('id') id: string) {
    const dir = this.dir();
    if (!dir || !/^[a-f0-9-]{10,}$/i.test(id)) return { ok: false as const };
    const gdir = this.galleryDir(dir);
    rmSync(path.join(gdir, `${id}.json`), { force: true });
    rmSync(path.join(gdir, `${id}.mp4`), { force: true });
    rmSync(path.join(gdir, `${id}-frames`), { recursive: true, force: true });
    return { ok: true as const };
  }

  @Get('file/:id')
  file(@Param('id') id: string, @Res() res: Response) {
    const dir = this.dir();
    const safe = /^[a-f0-9-]{10,}$/i.test(id);
    const p = dir && safe ? path.join(this.galleryDir(dir), `${id}.mp4`) : '';
    if (!p || !existsSync(p)) { res.status(404).end(); return; }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(statSync(p).size));
    createReadStream(p).pipe(res);
  }

  // Atomic: stream to .part, verify, rename (same rationale as the image models).
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
}
