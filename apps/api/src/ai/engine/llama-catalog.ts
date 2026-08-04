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
  win32: {
    file: `llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`,
    kind: "zip-flat",
    approxBytes: 18_200_000,
  },
  darwin: {
    file: `llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz`,
    kind: "targz-stripped",
    approxBytes: 10_800_000,
  },
  linux: {
    file: `llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz`,
    kind: "targz-stripped",
    approxBytes: 16_300_000,
  },
};

export const engineUrl = (file: string): string =>
  `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${file}`;

export const SERVER_BIN =
  process.platform === "win32" ? "llama-server.exe" : "llama-server";

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

/**
 * One file of a model that ships in several.
 *
 * Past a certain size publishers stop shipping a single file — HuggingFace
 * itself caps them — so a large model arrives as a numbered set. That turns out
 * to suit this project exactly: each part carries its own hash, so each travels
 * between peers on its own, is verified on its own, and a transfer that fails
 * halfway costs one part rather than eighty gigabytes.
 */
export interface CatalogPart {
  file: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface CatalogModel {
  id: string;
  label: string;
  description: string;
  url: string;
  file: string;
  /**
   * Set for a model the user supplied from their own disk: the weights are
   * used where they already are, never copied into the app's directory. People
   * keep GGUF files in one place and share them between tools; duplicating
   * several gigabytes to satisfy our layout would be rude.
   */
  absolutePath?: string;
  /**
   * SHA-256 of the weights, taken from the publisher's own record (HuggingFace
   * stores it as the LFS oid) and checked against the real bytes on disk.
   *
   * This is what lets a model be accepted from a STRANGER. Name and size can be
   * forged; the hash cannot. Without it, peer-to-peer sharing would mean
   * trusting whoever answers first — with it, the file either is the model or it
   * is discarded, and it no longer matters who handed it over.
   */
  sha256?: string;
  sizeBytes: number;
  /**
   * Set when the weights are split across several files. `file` and `url` then
   * describe part one, which is what llama.cpp is pointed at — it finds the
   * rest itself, provided they sit in the same folder under their own names.
   */
  parts?: CatalogPart[];
  /** Context the server is started with. Never 0: that means "read from the
   *  model", and some models declare 262144, which reserves a working set
   *  large enough to make the machine unusable. */
  contextTokens: number;
  recommended: boolean;
}

/**
 * Neurion's own models. Everything here is downloaded and run by Neurion itself,
 * with no other program involved — that is the whole point: a machine that has
 * never heard of ollama must still be able to get a model.
 *
 * gemma2-2b is the default, chosen by measurement rather than by size intuition.
 * On a CPU-only Ryzen 6800H, 13 deterministic cases, 3 samples each, driven
 * through /api/chat/stream:
 *
 *   gemma2:2b      1.6 GB   92% correct   1229 ms median
 *   llama3.2:3b    2.0 GB   88%            842 ms
 *   qwen2.5:3b     1.9 GB   86%            809 ms
 *   qwen2.5:7b     4.7 GB   90%           1680 ms
 *
 * The smallest candidate was also the most correct, so the default is 2B rather
 * than the 3-4B class that seemed obvious beforehand. Nothing else in this list
 * has been benchmarked, only verified to download and run, so nothing else
 * claims to be recommended.
 *
 * Every URL is pinned to a HuggingFace commit revision, never to `main`, so the
 * bytes behind a shipped release cannot change underneath it — verified by
 * negative control: the same path with a bogus sha returns 404 rather than
 * silently serving main. Every entry was fetched anonymously and its first bytes
 * checked for the GGUF magic, so a repo that quietly requires a token cannot
 * pass. sizeBytes is the observed Content-Length, not an estimate.
 *
 * No vision model ships: those need a separate mmproj projector passed to
 * llama-server, and a single-file vision GGUF downloads happily and then ignores
 * images — a worse failure than not offering it.
 */
/** Pinned to an exact revision, like every other entry: a tag can move. */
const V4_BASE =
  "https://huggingface.co/unsloth/DeepSeek-V4-Flash-GGUF/resolve/e3aa0d6a5fa4f820d9e132ac1fd1d01e1b2b49e0/UD-IQ1_S";

export const CATALOG: CatalogModel[] = [

  {
    id: "qwen2.5-0.5b",
    label: "Qwen 2.5 · 0.5B",
    description:
      "Il più piccolo: per PC datati, meno di 1 GB di RAM libera; risponde subito ma resta basilare.",
    url: "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/41ba88dbac95fed2528c92514c131d73eb5a174b/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf",
    file: "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf",
    sha256: "6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653",
    sizeBytes: 397_808_192,
    contextTokens: 4096,
    recommended: false,
  },
  {
    id: "qwen2.5-1.5b",
    label: "Qwen 2.5 · 1.5B",
    description:
      "Per macchine modeste: circa 1,5 GB di RAM libera, già molto più preciso dello 0.5B.",
    url: "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/9eadc66189c7641e1ddd226b8267a9119b2ce2d4/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
    file: "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
    sha256: "1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370",
    sizeBytes: 986_048_768,
    contextTokens: 4096,
    recommended: false,
  },
  {
    id: "qwen2.5-coder-1.5b",
    label: "Qwen 2.5 Coder · 1.5B",
    description:
      "Per l'agente su progetti piccoli: gira su qualsiasi portatile, circa 1,5 GB di RAM libera.",
    url: "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/1af47f78b1f9b0c242fabe43f7a365d5a67f3207/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
    file: "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
    sha256: "f530705d447660a4336c329981af164b471b60b974b1d808d57e8ec9fe23b239",
    sizeBytes: 986_048_800,
    contextTokens: 4096,
    recommended: false,
  },
  {
    id: "qwen3-1.7b",
    label: "Qwen 3 · 1.7B",
    description:
      "Ragiona passo passo prima di rispondere: il più leggero della categoria, circa 2 GB di RAM libera.",
    url: "https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/dcb19155b962dbb6389f4691a982043a8e651022/Qwen_Qwen3-1.7B-Q4_K_M.gguf",
    file: "Qwen_Qwen3-1.7B-Q4_K_M.gguf",
    sha256: "72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb",
    sizeBytes: 1_282_439_584,
    // Reasoning models spend tokens thinking before they answer, so a 4096
    // window can be eaten by the scratchpad and truncate the reply.
    contextTokens: 8192,
    recommended: false,
  },
  {
    id: "gemma2-2b",
    label: "Gemma 2 · 2B",
    description:
      "Predefinito: il più accurato tra i modelli leggeri, gira su qualsiasi PC.",
    url: "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/855f67caed130e1befc571b52bd181be2e858883/gemma-2-2b-it-Q4_K_M.gguf",
    file: "gemma-2-2b-it-Q4_K_M.gguf",
    sha256: "e0aee85060f168f0f2d8473d7ea41ce2f3230c1bc1374847505ea599288a7787",
    sizeBytes: 1_708_582_752,
    contextTokens: 4096,
    recommended: true,
  },
  {
    id: "llama3.2-3b",
    label: "Llama 3.2 · 3B",
    description:
      "Il più capace tra i leggeri: circa 3 GB di RAM libera, per un portatile ragionevolmente recente.",
    url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/5ab33fa94d1d04e903623ae72c95d1696f09f9e8/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff",
    sizeBytes: 2_019_377_696,
    contextTokens: 4096,
    recommended: false,
  },
  {
    id: "qwen3-4b",
    label: "Qwen 3 · 4B",
    description:
      "Ragionamento passo passo con buon equilibrio tra qualità e velocità; circa 3,5 GB di RAM libera.",
    url: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf",
    file: "Qwen3-4B-Q4_K_M.gguf",
    sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
    sizeBytes: 2_497_280_256,
    contextTokens: 8192,
    recommended: false,
  },
  {
    id: "granite4-tiny",
    label: "Granite 4.0 · Tiny (MoE)",
    description:
      "Modello a esperti: veloce come un modello piccolo ma più capace, servono circa 6 GB di RAM libera.",
    url: "https://huggingface.co/ibm-granite/granite-4.0-h-tiny-GGUF/resolve/08d5a8a9741dd5c1a95d2d39e25253226aa1464e/granite-4.0-h-tiny-Q4_K_M.gguf",
    file: "granite-4.0-h-tiny-Q4_K_M.gguf",
    sha256: "5a38b08c441ae1adbafb1d2b8a7167e0d48734d83af68b268cefea1eec553dcd",
    sizeBytes: 4_230_976_352,
    contextTokens: 4096,
    recommended: false,
  },
  {
    id: "deepseek-r1-7b",
    label: "DeepSeek R1 · 7B",
    description:
      "Il più forte su matematica e problemi logici; circa 6 GB di RAM libera ed è lento a rispondere.",
    url: "https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF/resolve/361004151d4f4f6b446dc5e6d46fbf4422a80d5f/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf",
    file: "DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf",
    sha256: "731ece8d06dc7eda6f6572997feb9ee1258db0784827e642909d9b565641937b",
    sizeBytes: 4_683_073_504,
    contextTokens: 8192,
    recommended: false,
  },
  {
    id: "qwen2.5-7b",
    label: "Qwen 2.5 · 7B",
    description:
      "Più capace sui compiti difficili; richiede circa 6 GB di RAM libera ed è più lento.",
    url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/8911e8a47f92bac19d6f5c64a2e2095bd2f7d031/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    file: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    sha256: "65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423",
    sizeBytes: 4_683_074_240,
    contextTokens: 4096,
    recommended: false,
  },
  {
    id: "qwen2.5-coder-7b",
    label: "Qwen 2.5 Coder · 7B",
    description:
      "Per l'agente sul codice di tutti i giorni: buone modifiche e velocità decente, circa 6 GB di RAM libera.",
    url: "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/1f629da0c8bed16b9e50cee91c70693650e66c35/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
    file: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
    sha256: "1664fccab734674a50763490a8c6931b70e3f2f8ec10031b54806d30e5f956b6",
    sizeBytes: 4_683_074_336,
    contextTokens: 4096,
    recommended: false,
  },
  {
    id: "llama3.1-8b",
    label: "Llama 3.1 · 8B",
    description:
      "Per chi ha almeno 6 GB di RAM libera: risposte più articolate e buon supporto multilingua.",
    url: "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/bf5b95e96dac0462e2a09145ec66cae9a3f12067/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    file: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    sha256: "7b064f5842bf9532c91456deda288a1b672397a54fa729aa665952863033557c",
    sizeBytes: 4_920_739_232,
    contextTokens: 4096,
    recommended: false,
  },
  {
    id: "gemma3-12b",
    label: "Gemma 3 · 12B",
    description:
      "Il più preparato del catalogo generale: servono almeno 9 GB di RAM libera e le risposte sono più lente.",
    url: "https://huggingface.co/bartowski/google_gemma-3-12b-it-GGUF/resolve/648e3a36a77c8a9f12d86e741f9dcb9089c769c4/google_gemma-3-12b-it-Q4_K_M.gguf",
    file: "google_gemma-3-12b-it-Q4_K_M.gguf",
    sha256: "fc57f67efa46d711c346e587cbef7d049e95f3df8db2eb2271153343ef0acc7b",
    sizeBytes: 7_300_575_264,
    contextTokens: 4096,
    recommended: false,
  },
  {
    id: "qwen2.5-coder-14b",
    label: "Qwen 2.5 Coder · 14B",
    description:
      "Per refactoring su più file: il più capace sul codice, ma servono circa 12 GB di RAM libera ed è lento su CPU.",
    url: "https://huggingface.co/bartowski/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/5b379ec4bf71bafecb5f9081ad28b19939128988/Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
    file: "Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
    sha256: "2946d28c9e1bb2bcae6d42e8678863a31775df6f740315c7d7e6d6b6411f5937",
    sizeBytes: 8_988_111_072,
    contextTokens: 4096,
    recommended: false,
  },
  {
    // The first model here that no ordinary machine can hold, and the reason
    // the parts mechanism exists. 256 experts of which 6 fire per token, so the
    // work per token is small while the weights are enormous — which is exactly
    // the shape a network of people is good at carrying and a single laptop is
    // not.
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash · 284B (MoE)",
    description:
      "Enorme: 284 miliardi di parametri, di cui 13 attivi per token. Servono circa 90 GB fra RAM e disco veloce — non gira su un portatile. Arriva in tre parti, ognuna verificata per conto suo.",
    url: `${V4_BASE}/DeepSeek-V4-Flash-UD-IQ1_S-00001-of-00003.gguf`,
    file: "DeepSeek-V4-Flash-UD-IQ1_S-00001-of-00003.gguf",
    sha256: "b191572a6376fecf1bb653b0fd04fa0d38c4eadbaa995f1ad8ac604dea64649a",
    sizeBytes: 82539237024,
    parts: [
      {
        file: "DeepSeek-V4-Flash-UD-IQ1_S-00001-of-00003.gguf",
        url: `${V4_BASE}/DeepSeek-V4-Flash-UD-IQ1_S-00001-of-00003.gguf`,
        sha256: "b191572a6376fecf1bb653b0fd04fa0d38c4eadbaa995f1ad8ac604dea64649a",
        sizeBytes: 5_256_864,
      },
      {
        file: "DeepSeek-V4-Flash-UD-IQ1_S-00002-of-00003.gguf",
        url: `${V4_BASE}/DeepSeek-V4-Flash-UD-IQ1_S-00002-of-00003.gguf`,
        sha256: "6907d2c7b3389624c0ad8face70ce8b5e14d662f9aaa51e5f7ef8ae389735750",
        sizeBytes: 49_975_054_912,
      },
      {
        file: "DeepSeek-V4-Flash-UD-IQ1_S-00003-of-00003.gguf",
        url: `${V4_BASE}/DeepSeek-V4-Flash-UD-IQ1_S-00003-of-00003.gguf`,
        sha256: "53dba406a9158bf2628f7b04190096fc236ff63d0a1bf189902c0b87587a3cce",
        sizeBytes: 32_558_925_248,
      },
    ],
    contextTokens: 8192,
    recommended: false,
  },
];

export const findModel = (id: string): CatalogModel | undefined =>
  CATALOG.find((m) => m.id === id);
