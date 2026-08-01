import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn, ChildProcess, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import {
  CATALOG,
  ENGINE_ASSETS,
  LLAMA_LICENSE_NOTICE,
  LLAMA_TAG,
  SERVER_BIN,
  engineUrl,
  findModel,
  type CatalogModel,
} from "./llama-catalog";
import { downloadFile, fileReady } from "./download.util";
import { ProviderResolverService } from "../provider-resolver.service";

export type EngineStage = "engine" | "model" | "starting";

export interface EngineState {
  modelId: string;
  file: string;
  contextTokens: number;
  port: number;
  /** Set when the weights live outside the app directory (user-supplied). */
  absolutePath?: string;
  label?: string;
}

export type EngineStatus =
  | { state: "unavailable"; reason: string }
  | { state: "unsupported"; platform: string }
  | { state: "needs_setup"; models: PublicModel[] }
  | { state: "installing"; stage: EngineStage; percent: number }
  | { state: "starting"; modelId: string }
  | {
      state: "ready";
      modelId: string;
      /** The full catalogue, so the UI can offer another model without a reload. */
      models?: PublicModel[];
      /** Human name of what is loaded. For a user-supplied file, its filename. */
      label?: string;
      /** Set only when the model came from a path the user chose. */
      path?: string;
      port: number;
      baseUrl: string;
    }
  | { state: "error"; message: string };

export interface PublicModel {
  id: string;
  label: string;
  description: string;
  sizeBytes: number;
  installed: boolean;
  recommended: boolean;
}

/**
 * Owns a bundled llama.cpp server so Neurion can run a model on its own,
 * instead of requiring the user to install and start ollama first. A fresh
 * install that finds no engine used to answer with a labelled mock, which reads
 * to a user as "the AI is bad" rather than "there is no AI here".
 *
 * The API owns this process rather than Electron: the download + progress +
 * status machinery already lives here (see image.controller.ts), and the web app
 * talks to the API, not to Electron IPC.
 *
 * Consequence that has to be handled: the desktop shell restarts a wedged API
 * with `taskkill /f /t`, which kills the whole descendant tree — including this
 * child. State is therefore persisted to disk and the server is respawned on
 * bootstrap, so an API restart does not silently leave the user without an
 * engine.
 */
@Injectable()
export class LlamaEngineService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LlamaEngineService.name);
  private proc: ChildProcess | null = null;
  private installing: { stage: EngineStage; percent: number } | null = null;
  private lastError: string | null = null;
  private ready = false;

  constructor(
    private readonly config: ConfigService,
    private readonly resolver: ProviderResolverService,
  ) {
    // Register with the resolver so a ready engine becomes a routable source.
    this.resolver.registerBundledEngine(this);
  }

  // --- paths -------------------------------------------------------------

  /** Set by the desktop shell to a persistent per-user directory. */
  dir(): string | null {
    return (
      this.config.get<string>("NEURION_TEXT_DIR") ||
      process.env.NEURION_TEXT_DIR ||
      null
    );
  }
  private binDir(dir: string): string {
    return join(dir, "bin");
  }
  private binPath(dir: string): string {
    return join(this.binDir(dir), SERVER_BIN);
  }
  private modelPath(dir: string, file: string): string {
    return join(dir, "models", file);
  }
  /** Where this model's weights actually are: the user's own path, or ours. */
  private weightsPath(dir: string, m: CatalogModel): string {
    return m.absolutePath ?? this.modelPath(dir, m.file);
  }
  private statePath(dir: string): string {
    return join(dir, "engine.json");
  }

  port(): number {
    return Number(this.config.get<string>("NEURION_LLAMA_PORT") ?? 8095);
  }
  baseUrl(): string {
    return `http://127.0.0.1:${this.port()}/v1`;
  }
  /** Models are exposed under this prefix so their ids cannot collide with ollama tags. */
  alias(modelId: string): string {
    return `neurion/${modelId}`;
  }

  private readState(dir: string): EngineState | null {
    try {
      return JSON.parse(
        readFileSync(this.statePath(dir), "utf8"),
      ) as EngineState;
    } catch {
      return null;
    }
  }
  private writeState(dir: string, state: EngineState): void {
    try {
      writeFileSync(this.statePath(dir), JSON.stringify(state, null, 2));
    } catch {
      /* best effort */
    }
  }

  // --- install -----------------------------------------------------------

  private engineInstalled(dir: string): boolean {
    // Size is a poor proxy here: with GGML_BACKEND_DL the shipped
    // llama-server.exe is a 9 KB launcher and the actual code lives in
    // llama-server-impl.dll next to it. A 100 KB floor rejected a perfectly
    // good install. Completeness of the archive is already guaranteed by the
    // .part-then-rename download, so existence is the right test.
    return fileReady(this.binPath(dir), 1024);
  }

  async ensureEngine(
    dir: string,
    onProgress: (p: number) => void,
  ): Promise<void> {
    if (this.engineInstalled(dir)) return;
    const asset = ENGINE_ASSETS[process.platform];
    if (!asset)
      throw new Error(`local engine not available for ${process.platform}`);

    mkdirSync(this.binDir(dir), { recursive: true });
    const archive = join(dir, asset.file);
    await downloadFile(engineUrl(asset.file), archive, (p) => onProgress(p), {
      expectedBytes: asset.approxBytes,
      toleranceRatio: 0.5,
    });

    if (asset.kind === "zip-flat") {
      new AdmZip(archive).extractAllTo(this.binDir(dir), true);
    } else {
      // Tarballs wrap everything in a single llama-<tag> directory. Node has no
      // tar reader; every platform shipping these archives has the tool.
      const res = spawnSync(
        "tar",
        ["-xzf", archive, "-C", this.binDir(dir), "--strip-components=1"],
        { windowsHide: true, timeout: 120_000 },
      );
      if (res.status !== 0) {
        throw new Error(
          `tar failed: ${res.stderr?.toString().slice(0, 200) ?? res.status}`,
        );
      }
    }
    rmSync(archive, { force: true });

    // MIT obliges the licence to travel with the binaries, and the Windows zip
    // does not carry it.
    try {
      writeFileSync(
        join(this.binDir(dir), "LICENSE-llama.cpp.txt"),
        LLAMA_LICENSE_NOTICE,
      );
    } catch {
      /* best effort */
    }

    if (!this.engineInstalled(dir)) {
      throw new Error(`engine binary missing after extracting ${asset.file}`);
    }
    this.logger.log(`local engine installed (llama.cpp ${LLAMA_TAG})`);
  }

  private modelInstalled(dir: string, m: CatalogModel): boolean {
    return fileReady(this.weightsPath(dir, m), m.sizeBytes * 0.9);
  }

  /**
   * Describe a GGUF the user already has on disk as if it were a catalog entry,
   * so the rest of the lifecycle — start, persist, respawn — needs no special
   * case. Its size is read from the file rather than declared, because nothing
   * here downloaded it.
   */
  private localModel(
    absolutePath: string,
    contextTokens: number,
  ): CatalogModel {
    const name = absolutePath.split(/[\\/]/).pop() ?? "model.gguf";
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(absolutePath).size;
    } catch {
      /* missing file is caught by the caller's readiness check */
    }
    return {
      id: "local",
      label: name.replace(/\.gguf$/i, ""),
      description: absolutePath,
      url: "",
      file: name,
      absolutePath,
      sizeBytes,
      contextTokens,
      recommended: false,
    };
  }

  /**
   * Run a model the user points at, wherever it lives. People accumulate GGUF
   * files and share them between tools; requiring a re-download of something
   * already on the disk would be the wrong answer.
   */
  async useLocalModel(
    absolutePath: string,
    contextTokens?: number,
  ): Promise<void> {
    const dir = this.dir();
    if (!dir) throw new Error("no engine directory configured");
    if (!/\.gguf$/i.test(absolutePath)) {
      throw new Error("only .gguf model files are supported");
    }
    if (!existsSync(absolutePath)) {
      throw new Error(`file not found: ${absolutePath}`);
    }
    // The engine binary still has to be there, even when the weights are not ours.
    this.lastError = null;
    this.setInstalling("engine", 0);
    try {
      await this.ensureEngine(dir, (p) => this.setInstalling("engine", p));
      this.setInstalling("starting", 100);
      await this.start(
        dir,
        this.localModel(
          absolutePath,
          contextTokens ?? Number(this.config.get("AI_OLLAMA_NUM_CTX") ?? 4096),
        ),
      );
    } finally {
      this.clearInstalling();
    }
  }

  async ensureModel(
    dir: string,
    m: CatalogModel,
    onProgress: (p: number) => void,
  ): Promise<void> {
    if (this.modelInstalled(dir, m)) return;
    mkdirSync(join(dir, "models"), { recursive: true });
    await downloadFile(
      m.url,
      this.modelPath(dir, m.file),
      (p) => onProgress(p),
      {
        expectedBytes: m.sizeBytes,
      },
    );
  }

  // --- process -----------------------------------------------------------

  private async probe(timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port()}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async start(dir: string, m: CatalogModel): Promise<void> {
    await this.stop();
    const args = [
      "-m",
      this.weightsPath(dir, m),
      "-a",
      this.alias(m.id),
      "--host",
      "127.0.0.1",
      "--port",
      String(this.port()),
      // Always explicit. `-c 0` means "read from the model", and models that
      // declare a 262144-token context reserve a working set big enough to
      // bring a normal machine to its knees.
      "-c",
      String(m.contextTokens),
      "--no-webui",
    ];
    this.logger.log(`starting local engine: ${SERVER_BIN} ${args.join(" ")}`);
    const child = spawn(this.binPath(dir), args, {
      windowsHide: true,
      cwd: this.binDir(dir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = child;
    child.stderr?.on("data", (b: Buffer) => {
      const line = b.toString().trim();
      if (line) this.logger.debug(`[llama] ${line.slice(0, 300)}`);
    });
    child.on("exit", (code) => {
      this.logger.warn(`local engine exited (code ${code})`);
      if (this.proc === child) {
        this.proc = null;
        this.ready = false;
      }
    });

    // A cold load of a multi-GB model on a CPU takes tens of seconds, so this
    // deadline is generous on purpose.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error("local engine exited during startup");
      if (await this.probe()) {
        this.ready = true;
        this.writeState(dir, {
          modelId: m.id,
          file: m.file,
          contextTokens: m.contextTokens,
          port: this.port(),
          absolutePath: m.absolutePath,
          label: m.label,
        });
        this.logger.log(`local engine ready on ${this.baseUrl()} (${m.id})`);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    await this.stop();
    throw new Error("local engine did not become ready within 180s");
  }

  async stop(): Promise<void> {
    const child = this.proc;
    this.proc = null;
    this.ready = false;
    if (!child?.pid) return;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/f", "/t"], {
          windowsHide: true,
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* already gone */
    }
  }

  // --- lifecycle ---------------------------------------------------------

  async onApplicationBootstrap(): Promise<void> {
    const dir = this.dir();
    if (!dir) return;
    // Clean up part-files from a download interrupted by a crash; nothing else
    // ever removes them.
    try {
      for (const sub of ["", "models"]) {
        const d = join(dir, sub);
        if (!existsSync(d)) continue;
        for (const f of readdirSync(d)) {
          if (!f.endsWith(".part")) continue;
          const p = join(d, f);
          if (Date.now() - statSync(p).mtimeMs > 24 * 3600_000)
            rmSync(p, { force: true });
        }
      }
    } catch {
      /* best effort */
    }

    // Respawn what was running before: the desktop shell's API restart kills
    // this process along with the tree.
    const state = this.readState(dir);
    if (!state) return;
    // A user-supplied model has no catalog entry, so rebuild one from the saved
    // state; otherwise their choice would be silently forgotten on every restart.
    const m = state.absolutePath
      ? this.localModel(state.absolutePath, state.contextTokens)
      : findModel(state.modelId);
    if (!m || !this.engineInstalled(dir) || !this.modelInstalled(dir, m))
      return;
    if (await this.probe(1500)) {
      this.ready = true; // survived; adopt it rather than starting a second one
      return;
    }
    this.start(dir, m).catch((e) => {
      this.lastError = (e as Error).message;
      this.logger.error(`could not restore local engine: ${this.lastError}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  // --- public API --------------------------------------------------------

  isReady(): boolean {
    return this.ready;
  }

  setInstalling(stage: EngineStage, percent: number): void {
    this.installing = { stage, percent };
  }
  clearInstalling(): void {
    this.installing = null;
  }
  setError(message: string | null): void {
    this.lastError = message;
  }

  async status(): Promise<EngineStatus> {
    const dir = this.dir();
    if (!dir)
      return { state: "unavailable", reason: "NEURION_TEXT_DIR is not set" };
    if (!ENGINE_ASSETS[process.platform]) {
      return { state: "unsupported", platform: process.platform };
    }
    if (this.installing) {
      return { state: "installing", ...this.installing };
    }
    if (this.lastError) return { state: "error", message: this.lastError };

    const state = this.readState(dir);
    if (state && this.ready) {
      return {
        state: "ready",
        modelId: state.modelId,
        // "local" alone does not tell anyone WHICH of their files is loaded.
        label: state.label,
        path: state.absolutePath,
        // Always sent. Offering the catalogue only while nothing is installed
        // meant that once a user had one model they could never be shown the
        // others — which, on a machine with no ollama, is every other model
        // they can get at all.
        models: this.publicCatalog(dir),
        port: this.port(),
        baseUrl: this.baseUrl(),
      };
    }
    if (state && this.proc)
      return { state: "starting", modelId: state.modelId };

    return { state: "needs_setup", models: this.publicCatalog(dir) };
  }

  /** The catalogue as the UI sees it, with what is already on disk marked. */
  private publicCatalog(dir: string): PublicModel[] {
    return CATALOG.map((m) => ({
      id: m.id,
      label: m.label,
      description: m.description,
      sizeBytes: m.sizeBytes,
      installed: this.modelInstalled(dir, m),
      recommended: m.recommended,
    }));
  }

  /** Install (if needed) and start a catalog model. Progress is reported per stage. */
  async setup(
    modelId: string,
    onProgress: (stage: EngineStage, percent: number) => void,
  ): Promise<void> {
    const dir = this.dir();
    if (!dir) throw new Error("no engine directory configured");
    const m = findModel(modelId);
    if (!m) throw new Error(`unknown model ${modelId}`);

    this.lastError = null;
    try {
      this.setInstalling("engine", 0);
      await this.ensureEngine(dir, (p) => {
        this.setInstalling("engine", p);
        onProgress("engine", p);
      });
      this.setInstalling("model", 0);
      await this.ensureModel(dir, m, (p) => {
        this.setInstalling("model", p);
        onProgress("model", p);
      });
      this.setInstalling("starting", 100);
      onProgress("starting", 100);
      await this.start(dir, m);
    } finally {
      this.clearInstalling();
    }
  }
}
