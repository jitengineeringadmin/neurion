/**
 * The engine and the models Neurion ships on its own, so a fresh install can
 * answer a question without the user first discovering, installing and starting
 * a separate inference server.
 */

/**
 * llama.cpp publishes a release per commit, several times a day, so this is
 * pinned to an exact tag rather than tracking `latest`.
 *
 * Windows needs no CPU-variant choice: since 2025 there is a single `win-cpu`
 * package built with GGML_CPU_ALL_VARIANTS, and the right microarchitecture DLL
 * (haswell, skylakex, …) is selected at runtime. Any guide that tells you to
 * pick the AVX2 asset is out of date.
 *
 * The Windows zip is FLAT (binaries at the archive root); the macOS and Linux
 * tarballs contain a single `llama-<tag>` directory that has to be stripped.
 */
export const LLAMA_TAG = "b10107";

export interface EngineAsset {
  file: string;
  /** Archive layout: a flat zip, or a tarball with one directory to strip. */
  kind: "zip-flat" | "targz-stripped";
  approxBytes: number;
}

export const ENGINE_ASSETS: Partial<Record<NodeJS.Platform, EngineAsset>> = {
  win32: { file: `llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`, kind: "zip-flat", approxBytes: 18_200_000 },
  darwin: { file: `llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz`, kind: "targz-stripped", approxBytes: 10_800_000 },
  linux: { file: `llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz`, kind: "targz-stripped", approxBytes: 16_300_000 },
};

export const engineUrl = (file: string): string =>
  `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${file}`;

export const SERVER_BIN = process.platform === "win32" ? "llama-server.exe" : "llama-server";

/**
 * llama.cpp is MIT licensed, so redistributing the binaries inside Neurion is
 * permitted — on the condition that the copyright and licence text travel with
 * them. The Windows zip does not include LICENSE (the packaging step only adds
 * it on macOS/Linux), so it is written out at install time instead.
 */
export const LLAMA_LICENSE_NOTICE = `llama.cpp — MIT License
Copyright (c) 2023-2024 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: https://github.com/ggml-org/llama.cpp (release ${LLAMA_TAG})
`;

export interface CatalogModel {
  id: string;
  label: string;
  description: string;
  url: string;
  file: string;
  sizeBytes: number;
  /** Context the server is started with. Never 0: that means "read from the
   *  model", and some models declare 262144, which reserves a working set
   *  large enough to make the machine unusable. */
  contextTokens: number;
  recommended: boolean;
}

/**
 * Chosen by measurement, not by size intuition. On a CPU-only Ryzen 6800H,
 * 13 deterministic cases, 3 samples each, driven through /api/chat/stream:
 *
 *   gemma2:2b      1.6 GB   92% correct   1229 ms median
 *   llama3.2:3b    2.0 GB   88%            842 ms
 *   qwen2.5:3b     1.9 GB   86%            809 ms
 *   qwen2.5:7b     4.7 GB   90%           1680 ms
 *
 * The smallest candidate was also the most correct, so the default is 2B rather
 * than the 3-4B class that seemed obvious beforehand.
 *
 * URLs are pinned to a HuggingFace revision, not to `main`, so the bytes behind
 * a release cannot change after it ships.
 */
export const CATALOG: CatalogModel[] = [
  {
    id: "gemma2-2b",
    label: "Gemma 2 · 2B",
    description: "Predefinito: il più accurato tra i modelli leggeri, gira su qualsiasi PC.",
    url: "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/855f67caed130e1befc571b52bd181be2e858883/gemma-2-2b-it-Q4_K_M.gguf",
    file: "gemma-2-2b-it-Q4_K_M.gguf",
    sizeBytes: 1_710_000_000,
    contextTokens: 4096,
    recommended: true,
  },
  {
    id: "qwen2.5-7b",
    label: "Qwen 2.5 · 7B",
    description: "Più capace sui compiti difficili; richiede circa 6 GB di RAM libera ed è più lento.",
    url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/8911e8a47f92bac19d6f5c64a2e2095bd2f7d031/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    file: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    sizeBytes: 4_680_000_000,
    contextTokens: 4096,
    recommended: false,
  },
];

export const findModel = (id: string): CatalogModel | undefined =>
  CATALOG.find((m) => m.id === id);
