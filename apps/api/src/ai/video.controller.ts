import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

interface Active { source: string; id?: string; path: string; label: string; sampler: string; cfg: number; steps: number }

class VideoDto {
  @IsString()
  @MaxLength(2000)
  prompt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  negative?: string;
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
    if (!a) return { ok: false as const, error: 'no image model selected' };
    const ff = this.ffmpeg(dir);
    if (!ff) return { ok: false as const, error: 'video engine not set up' };
    if (busy) return { ok: false as const, error: 'another video is generating — one at a time' };

    const id = randomUUID();
    const gdir = this.galleryDir(dir);
    mkdirSync(gdir, { recursive: true });
    const meta: Record<string, unknown> = { id, kind: 'video', prompt, model: a.label, status: 'running', progress: '0/' + FRAMES, ts: Date.now(), error: '' };
    const save = () => { try { writeFileSync(path.join(gdir, `${id}.json`), JSON.stringify(meta)); } catch { /* ignore */ } };
    save();
    busy = true;
    void this.render(dir, ff, a, id, prompt, (dto.negative ?? '').trim(), meta, save).finally(() => { busy = false; });
    return { ok: true as const, id };
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

  private run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const cp = spawn(bin, args, { cwd, windowsHide: true });
      let err = '';
      cp.stderr.on('data', (d) => { err += d.toString(); if (err.length > 8000) err = err.slice(-4000); });
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
