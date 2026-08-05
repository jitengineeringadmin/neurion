import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import path from "node:path";

/**
 * Local audio for the video features, three tiers (all on the user's machine):
 * - music: a small pack of AI-generated mood tracks hosted on neurionproject.org
 *   (we generated them with MusicGen, so no licensing/hotlink fragility);
 * - tts: Piper voice-over — one binary + an Italian voice, same turnkey pattern
 *   as the image/video engines;
 * - gen: experimental in-app MusicGen (transformers.js, ONNX on CPU) for custom
 *   music from a prompt — slow, labeled experimental.
 * The 4th tier (synced AI foley) needs GPU nodes → future video.v1-style lane.
 */

const MUSIC_BASE = "https://neurionproject.org/assets/music";
export const MOODS = ["epic", "calm", "happy", "dark"] as const;
export type Mood = (typeof MOODS)[number];

/**
 * Piper ships a build per platform AND per architecture, so the key is both —
 * an Apple Silicon Mac and an Intel one need different files, and so do a
 * Raspberry Pi and a desktop. A missing entry means "no build exists for this
 * machine", which is a different thing from "we never got round to it".
 */
const PIPER_TAG = "2023.11.14-2";
const PIPER_ASSET: Record<string, string> = {
  "win32-x64": "piper_windows_amd64.zip",
  "linux-x64": "piper_linux_x86_64.tar.gz",
  "linux-arm64": "piper_linux_aarch64.tar.gz",
  "linux-arm": "piper_linux_armv7l.tar.gz",
  "darwin-arm64": "piper_macos_aarch64.tar.gz",
  "darwin-x64": "piper_macos_x64.tar.gz",
};
const piperAsset = (): string | null =>
  PIPER_ASSET[`${process.platform}-${process.arch}`] ?? null;
const PIPER_URL = (file: string) =>
  `https://github.com/rhasspy/piper/releases/download/${PIPER_TAG}/${file}`;
const PIPER_BIN = process.platform === "win32" ? "piper.exe" : "piper";

const VOICE_BASE =
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/paola/medium";
const VOICE = "it_IT-paola-medium.onnx";

@Injectable()
export class AudioService {
  private readonly logger = new Logger(AudioService.name);
  private genPipeline: unknown | null = null;

  constructor(private readonly config: ConfigService) {}

  dir(): string | null {
    const base =
      this.config.get<string>("NEURION_IMAGE_DIR") ||
      process.env.NEURION_IMAGE_DIR ||
      null;
    return base ? path.join(base, "audio") : null;
  }
  musicPath(mood: Mood) {
    const d = this.dir();
    return d ? path.join(d, "music", `${mood}.mp3`) : "";
  }
  /** Every piper archive unpacks into a `piper/` directory of its own. */
  private piperDir() {
    const d = this.dir();
    return d ? path.join(d, "piper", "piper") : "";
  }
  private piperExe() {
    const d = this.piperDir();
    return d ? path.join(d, PIPER_BIN) : "";
  }
  private voicePath() {
    const d = this.dir();
    return d ? path.join(d, "piper", VOICE) : "";
  }

  musicReady(): boolean {
    return MOODS.every((m) => {
      try {
        return statSync(this.musicPath(m)).size > 50_000;
      } catch {
        return false;
      }
    });
  }
  ttsReady(): boolean {
    return existsSync(this.piperExe()) && existsSync(this.voicePath());
  }
  genReady(): boolean {
    const d = this.dir();
    return !!d && existsSync(path.join(d, "gen.ready"));
  }

  status() {
    const d = this.dir();
    if (!d)
      return { music: "unavailable", tts: "unavailable", gen: "unavailable" };
    return {
      music: this.musicReady() ? "ready" : "needs_setup",
      tts: this.ttsReady()
        ? "ready"
        : piperAsset()
          ? "needs_setup"
          : "unsupported",
      gen: this.genReady() ? "ready" : "needs_setup",
    };
  }

  /** Download the 4-track mood pack from our own host. */
  async setupMusic(onPct: (p: number) => void): Promise<void> {
    const d = this.dir();
    if (!d) throw new Error("audio unavailable in this deployment");
    mkdirSync(path.join(d, "music"), { recursive: true });
    for (let i = 0; i < MOODS.length; i++) {
      const m = MOODS[i] as Mood;
      const out = this.musicPath(m);
      if (!existsSync(out) || statSync(out).size < 50_000) {
        await this.download(`${MUSIC_BASE}/${m}.mp3`, out, (pct) =>
          onPct(Math.round(((i + pct / 100) / MOODS.length) * 100)),
        );
      }
      onPct(Math.round(((i + 1) / MOODS.length) * 100));
    }
  }

  /** Download piper + the Italian voice — turnkey on every platform piper builds for. */
  async setupTts(onPct: (p: number) => void): Promise<void> {
    const d = this.dir();
    if (!d) throw new Error("audio unavailable in this deployment");
    const asset = piperAsset();
    if (!asset)
      throw new Error(
        `piper publishes no build for ${process.platform}-${process.arch}`,
      );
    const pdir = path.join(d, "piper");
    mkdirSync(pdir, { recursive: true });
    if (!existsSync(this.piperExe())) {
      const isZip = asset.endsWith(".zip");
      const archive = path.join(pdir, isZip ? "piper.zip" : "piper.tar.gz");
      await this.download(PIPER_URL(asset), archive, (p) =>
        onPct(Math.round(p * 0.2)),
      );
      if (isZip) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const AdmZip = require("adm-zip");
        // keepOriginalPermission: without it adm-zip writes everything 0666 and
        // the binary comes out unable to run.
        new AdmZip(archive).extractAllTo(pdir, true, true);
      } else {
        await this.untar(archive, pdir);
      }
      rmSync(archive, { force: true });
      if (process.platform !== "win32") {
        try {
          chmodSync(this.piperExe(), 0o755);
        } catch {
          /* tar normally carries the mode; this only covers the case it did not */
        }
      }
    }
    onPct(20);
    if (!existsSync(this.voicePath())) {
      await this.download(`${VOICE_BASE}/${VOICE}`, this.voicePath(), (p) =>
        onPct(20 + Math.round(p * 0.75)),
      );
      await this.download(
        `${VOICE_BASE}/${VOICE}.json`,
        `${this.voicePath()}.json`,
        () => onPct(97),
      );
    }
    onPct(100);
  }

  /** Load MusicGen once (first call downloads the ONNX model into our cache dir). */
  private async loadGen(
    onPct?: (p: number) => void,
  ): Promise<
    (prompt: string) => Promise<{ audio: Float32Array; sampling_rate: number }>
  > {
    const d = this.dir();
    if (!d) throw new Error("audio unavailable in this deployment");
    if (!this.genPipeline) {
      process.env.HF_HOME = path.join(d, "hf-cache"); // keep the model inside our engine dir
      const { pipeline } = await import("@huggingface/transformers");
      let last = 0;
      this.genPipeline = await pipeline(
        "text-to-audio",
        "Xenova/musicgen-small",
        {
          progress_callback: (p: { progress?: number }) => {
            const pct = Math.round(p.progress ?? 0);
            if (onPct && pct !== last) {
              last = pct;
              onPct(pct);
            }
          },
        } as never,
      );
      writeFileSync(path.join(d, "gen.ready"), "1");
    }
    const gen = this.genPipeline as (
      t: string,
      o: Record<string, unknown>,
    ) => Promise<{ audio: Float32Array; sampling_rate: number }>;
    return (prompt: string) =>
      gen(prompt, { max_new_tokens: 750, do_sample: true, guidance_scale: 3 });
  }

  async setupGen(onPct: (p: number) => void): Promise<void> {
    await this.loadGen(onPct);
  }

  /** Custom AI music (experimental, CPU, minutes-scale) → wav path. */
  async genMusic(prompt: string, outWav: string): Promise<void> {
    const gen = await this.loadGen();
    const out = await gen(prompt);
    writeFileSync(outWav, this.wav(out.audio, out.sampling_rate));
  }

  /** Voice-over via piper (text → wav). */
  async tts(text: string, outWav: string): Promise<void> {
    if (!this.ttsReady()) throw new Error("voice not set up");
    await new Promise<void>((resolve, reject) => {
      // Outside Windows piper links against shared libraries it ships beside
      // itself, and finds its espeak-ng data relative to where it runs. Neither
      // is on a default search path, so both are pointed at its own directory.
      const pdir = this.piperDir();
      const env = { ...process.env };
      if (process.platform === "linux")
        env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
          ? `${pdir}:${env.LD_LIBRARY_PATH}`
          : pdir;
      else if (process.platform === "darwin")
        env.DYLD_LIBRARY_PATH = env.DYLD_LIBRARY_PATH
          ? `${pdir}:${env.DYLD_LIBRARY_PATH}`
          : pdir;
      const cp = spawn(
        this.piperExe(),
        [
          "-m",
          this.voicePath(),
          "-c",
          `${this.voicePath()}.json`,
          "-f",
          outWav,
        ],
        { windowsHide: true, cwd: pdir, env },
      );
      let err = "";
      cp.stderr.on("data", (c) => (err += c.toString()));
      const to = setTimeout(() => {
        cp.kill();
        reject(new Error("tts timed out"));
      }, 120000);
      cp.on("error", (e) => {
        clearTimeout(to);
        reject(e);
      });
      cp.on("close", (code) => {
        clearTimeout(to);
        code === 0 && existsSync(outWav)
          ? resolve()
          : reject(new Error(err.slice(-160) || `piper exited ${code}`));
      });
      cp.stdin.write(text);
      cp.stdin.end();
    });
  }

  /** 16-bit PCM WAV encoder for MusicGen float output. */
  private wav(f32: Float32Array, rate: number): Buffer {
    const pcm = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++)
      pcm[i] = Math.max(
        -32768,
        Math.min(32767, Math.round((f32[i] ?? 0) * 32767)),
      );
    const b = Buffer.alloc(44 + pcm.length * 2);
    b.write("RIFF", 0);
    b.writeUInt32LE(36 + pcm.length * 2, 4);
    b.write("WAVE", 8);
    b.write("fmt ", 12);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(1, 22);
    b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * 2, 28);
    b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34);
    b.write("data", 36);
    b.writeUInt32LE(pcm.length * 2, 40);
    Buffer.from(pcm.buffer).copy(b, 44);
    return b;
  }

  /**
   * Unpack a .tar.gz with the system tar. Every platform that gets a tarball
   * here (Linux, macOS) ships one, and shelling out to it keeps the mode bits
   * that a JavaScript unpacker would drop.
   */
  private untar(archive: string, into: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const cp = spawn("tar", ["-xzf", archive, "-C", into], {
        windowsHide: true,
      });
      let err = "";
      cp.stderr.on("data", (c) => (err += c.toString()));
      cp.on("error", reject);
      cp.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(err.slice(-200) || `tar exited ${code}`)),
      );
    });
  }

  // Atomic download, same rationale as the model files.
  private async download(
    url: string,
    out: string,
    onProgress: (pct: number) => void,
  ): Promise<void> {
    mkdirSync(path.dirname(out), { recursive: true });
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body)
      throw new Error(`download failed HTTP ${res.status} (${url})`);
    const total = Number(res.headers.get("content-length") || 0);
    let got = 0;
    const tmp = `${out}.part`;
    const rs = Readable.fromWeb(res.body as never);
    rs.on("data", (c: Buffer) => {
      got += c.length;
      if (total > 0) onProgress((got / total) * 100);
    });
    try {
      await streamPipeline(rs, createWriteStream(tmp));
      if (total > 0 && got < total * 0.99)
        throw new Error("download incomplete");
      rmSync(out, { force: true });
      renameSync(tmp, out);
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw e;
    }
  }
}
