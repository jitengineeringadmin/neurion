import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GB = 1024 ** 3;

export interface OllamaModel {
  name: string;
  size?: number;
  size_vram?: number;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface GpuMemory {
  name: string;
  totalBytes: number;
  freeBytes: number;
}

@Injectable()
export class ModelMemoryService {
  constructor(private readonly config: ConfigService) {}

  private ollamaBase(): string {
    const base =
      this.config.get<string>("AI_OPENAI_COMPATIBLE_BASE_URL") ??
      "http://localhost:11434/v1";
    return base.replace(/\/v1\/?$/, "");
  }

  /**
   * NVIDIA only. On AMD and Apple Silicon this returns null, so the planner
   * falls through to the CPU branches — correct behaviour for the engines in
   * use, but it means "no GPU detected" must never be phrased to the user as
   * "you have no GPU".
   */
  private async gpu(): Promise<GpuMemory | null> {
    try {
      const { stdout } = await execFileAsync(
        "nvidia-smi",
        [
          "--query-gpu=name,memory.total,memory.free",
          "--format=csv,noheader,nounits",
        ],
        { timeout: 2500, windowsHide: true },
      );
      const line = stdout.trim().split(/\r?\n/)[0];
      if (!line) return null;
      const parts = line.split(",").map((part) => part.trim());
      const totalMiB = Number(parts[1]);
      const freeMiB = Number(parts[2]);
      if (!Number.isFinite(totalMiB) || !Number.isFinite(freeMiB)) return null;
      return {
        name: parts[0] ?? "NVIDIA GPU",
        totalBytes: totalMiB * 1024 ** 2,
        freeBytes: freeMiB * 1024 ** 2,
      };
    } catch {
      return null;
    }
  }

  private disk() {
    try {
      // Measure the volume the weights actually land on. Reporting free space
      // for the working directory is misleading when models live under the
      // user's app-data directory on a different drive.
      const path =
        this.config.get<string>("NEURION_TEXT_DIR") ??
        this.config.get<string>("NEURION_IMAGE_DIR") ??
        this.config.get<string>("NEURION_DATA_DIR") ??
        process.cwd();
      const stats = statfsSync(path);
      return {
        path,
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
      };
    } catch {
      return { path: null, totalBytes: null, freeBytes: null };
    }
  }

  private async ollamaModels(): Promise<{
    reachable: boolean;
    installed: OllamaModel[];
    loaded: OllamaModel[];
  }> {
    try {
      const [tagsResponse, psResponse] = await Promise.all([
        fetch(`${this.ollamaBase()}/api/tags`, {
          signal: AbortSignal.timeout(2500),
        }),
        fetch(`${this.ollamaBase()}/api/ps`, {
          signal: AbortSignal.timeout(2500),
        }).catch(() => null),
      ]);
      if (!tagsResponse.ok)
        return { reachable: false, installed: [], loaded: [] };
      const tags = (await tagsResponse.json()) as { models?: OllamaModel[] };
      const ps = psResponse?.ok
        ? ((await psResponse.json()) as { models?: OllamaModel[] })
        : {};
      return {
        reachable: true,
        installed: tags.models ?? [],
        loaded: ps.models ?? [],
      };
    } catch {
      return { reachable: false, installed: [], loaded: [] };
    }
  }

  private plan(
    model: OllamaModel | undefined,
    gpu: GpuMemory | null,
    ramFree: number,
    ramTotal: number,
    diskFree: number | null,
  ) {
    if (!model?.size) return null;
    const modelBytes = model.size;
    const runtimeReserve = Math.max(768 * 1024 ** 2, modelBytes * 0.18);
    const workingSet = modelBytes + runtimeReserve;
    const vramFree = gpu?.freeBytes ?? 0;
    const quant = model.details?.quantization_level ?? "unknown";
    let mode: "gpu" | "hybrid_offload" | "cpu_mmap" | "not_recommended";
    let reason: string;

    if (vramFree >= workingSet) {
      mode = "gpu";
      reason =
        "The quantized model and runtime reserve fit in currently free VRAM.";
    } else if (
      gpu &&
      vramFree >= 1024 ** 3 &&
      ramFree >= (workingSet - vramFree) * 1.15
    ) {
      mode = "hybrid_offload";
      reason =
        "Part of the model can stay on GPU while remaining layers are served from system RAM.";
    } else if (
      ramTotal >= Math.max(4 * GB, modelBytes * 0.45) &&
      workingSet <= ramTotal * 0.85 &&
      diskFree !== null &&
      diskFree >= modelBytes * 1.25
    ) {
      mode = "cpu_mmap";
      // Free RAM decides how this FEELS, and the verdict used to ignore it
      // entirely — the same answer came back whether the model loaded in half a
      // second or paged for a minute and a half. Measured on a 27.7 GB machine:
      // a 19 GB working set with ~11 GB free took 95 s to become usable, while
      // a 5 GB one took under 9 s.
      reason =
        workingSet <= ramFree
          ? "Fits in free RAM: it runs on the CPU and loads quickly."
          : "Larger than free RAM: it will be memory-mapped from disk, so the first load pages heavily and can take minutes. Close other applications first.";
    } else {
      mode = "not_recommended";
      reason =
        "Even disk mapping needs enough RAM for active layers, cache and runtime buffers; this model is too large for stable use.";
    }

    const alreadyCompact = /q[2345]/i.test(quant);
    return {
      mode,
      reason,
      modelBytes,
      runtimeReserveBytes: Math.round(runtimeReserve),
      estimatedWorkingSetBytes: Math.round(workingSet),
      quantization: quant,
      recommendedQuantization:
        mode === "gpu" || alreadyCompact ? null : "q4_K_M",
      runtimeHints: {
        memoryMap: true,
        gpuLayers:
          mode === "gpu"
            ? "all"
            : mode === "hybrid_offload"
              ? "auto/partial"
              : "none",
        kvCacheType: mode === "gpu" ? "q8_0" : "q4_0",
        suggestedContextTokens: mode === "cpu_mmap" ? 4096 : 8192,
      },
    };
  }

  async profile(modelName?: string) {
    const [gpu, ollama] = await Promise.all([this.gpu(), this.ollamaModels()]);
    const ram = { totalBytes: totalmem(), freeBytes: freemem() };
    const disk = this.disk();
    const model = modelName
      ? ollama.installed.find(
          (item) =>
            item.name === modelName ||
            item.name.replace(/:latest$/, "") ===
              modelName.replace(/:latest$/, ""),
        )
      : undefined;
    const loaded = modelName
      ? ollama.loaded.find(
          (item) =>
            item.name === modelName ||
            item.name.replace(/:latest$/, "") ===
              modelName.replace(/:latest$/, ""),
        )
      : undefined;
    return {
      hardware: { gpu, ram, disk },
      engine: { reachable: ollama.reachable, loaded },
      model: model ?? null,
      plan: this.plan(
        model,
        gpu,
        ram.freeBytes,
        ram.totalBytes,
        disk.freeBytes,
      ),
      facts: {
        diskActsAsVirtualVram: false,
        diskRole: "memory-mapped cold storage and CPU offload",
        compressionRole:
          "quantization reduces model weights; KV-cache quantization reduces context memory",
      },
    };
  }
}
