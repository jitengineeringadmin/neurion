/**
 * Neurion eval harness — latency and deterministic quality per model.
 *
 * Exists because every performance claim about this system was, until now,
 * unmeasured. It drives the real /api/chat/stream endpoint (not the provider in
 * isolation) so the numbers include Neurion's own overhead, which is the thing
 * a user actually waits for.
 *
 * Records the hardware profile with every run: results from a CPU-only laptop
 * and from a GPU box are not comparable, and a file of numbers with no machine
 * attached is worse than no numbers at all.
 *
 * Run:
 *   pnpm --filter @neurion/api eval
 *   EVAL_MODELS=qwen2.5:0.5b-instruct-q8_0,qwen2.5-coder:7b EVAL_RUNS=3 pnpm --filter @neurion/api eval
 *
 * Env:
 *   API             base URL (default http://127.0.0.1:8091)
 *   EVAL_EMAIL / EVAL_PASSWORD   credentials (default admin@neurion.local / neurion123)
 *   EVAL_MODELS     comma-separated model ids; default = the API's chatDefault
 *   EVAL_RUNS       measured repetitions per case (default 1)
 *   EVAL_CASES      comma-separated case ids to restrict the dataset
 *   EVAL_TIMEOUT_MS per-run timeout (default 300000 — a cold load can take minutes on CPU)
 *   EVAL_OUT        output dir (default <repo>/.runtime/eval)
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cpus, totalmem, freemem, hostname, platform, release } from "node:os";
import { execSync } from "node:child_process";

// apps/api is CommonJS (no "type": "module"), so __dirname is the portable
// anchor here — import.meta.url would not resolve.
const HERE = __dirname;
const API = process.env.API ?? "http://127.0.0.1:8091";
const BASE = `${API}/api`;
const EMAIL = process.env.EVAL_EMAIL ?? "admin@neurion.local";
const PASSWORD = process.env.EVAL_PASSWORD ?? "neurion123";
const RUNS = Number(process.env.EVAL_RUNS ?? 1);
const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS ?? 300_000);
const OUT_DIR = process.env.EVAL_OUT ?? join(HERE, "..", "..", "..", ".runtime", "eval");

interface Expect {
  type: "contains" | "regex" | "json";
  value?: string;
  keys?: string[];
  caseSensitive?: boolean;
}
interface Case {
  id: string;
  category: string;
  prompt: string;
  expect: Expect;
}

interface RunResult {
  model: string;
  caseId: string;
  category: string;
  cold: boolean;
  valid: boolean;
  invalidReason?: string;
  pass?: boolean;
  ttftClientMs?: number;
  serverFirstTokenMs?: number;
  overheadMs?: number;
  totalMs?: number;
  genMs?: number;
  outputChars?: number;
  completionTokens?: number;
  tokPerSec?: number;
  charPerSec?: number;
  provider?: string;
  servedModel?: string;
  lane?: string;
}

// --- hardware profile -----------------------------------------------------

function gpuInfo(): string {
  if (platform() !== "win32") return "unknown";
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)"',
      { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out || "unknown";
  } catch {
    return "unknown";
  }
}

/** Which models the local engine currently holds in memory, and on what device. */
async function residentModels(): Promise<Array<{ name: string; processor: string }>> {
  const base = (process.env.AI_OPENAI_COMPATIBLE_BASE_URL ?? "http://127.0.0.1:11434/v1").replace(
    /\/v1\/?$/,
    "",
  );
  try {
    const res = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      models?: Array<{ name: string; size_vram?: number; size?: number }>;
    };
    return (json.models ?? []).map((m) => ({
      name: m.name,
      processor: m.size_vram && m.size_vram > 0 ? "gpu" : "cpu",
    }));
  } catch {
    return [];
  }
}

function hardwareProfile(): Record<string, unknown> {
  const c = cpus();
  return {
    host: hostname(),
    os: `${platform()} ${release()}`,
    cpu: c[0]?.model?.trim() ?? "unknown",
    threads: c.length,
    ramTotalGb: +(totalmem() / 1024 ** 3).toFixed(1),
    ramFreeGb: +(freemem() / 1024 ** 3).toFixed(1),
    gpu: gpuInfo(),
  };
}

// --- HTTP -----------------------------------------------------------------

async function req<T>(path: string, method: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Stream one message and time it. The SSE body is read incrementally: buffering
 * the whole response first would collapse every inter-token gap and make the
 * time-to-first-token meaningless.
 */
async function streamOnce(
  token: string,
  model: string,
  prompt: string,
): Promise<{
  text: string;
  ttftClientMs: number | null;
  totalMs: number;
  routing: Record<string, unknown> | null;
  final: Record<string, unknown> | null;
  errored: string | null;
}> {
  const t0 = Date.now();
  let ttftClientMs: number | null = null;
  let text = "";
  let routing: Record<string, unknown> | null = null;
  let final: Record<string, unknown> | null = null;
  let errored: string | null = null;

  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    // No conversationId: every run starts a fresh conversation, otherwise the
    // history grows between runs and the prompt-token count drifts.
    body: JSON.stringify({ message: prompt, preferredModel: model }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok || !res.body) throw new Error(`stream -> ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim();
      const dataLine = /^data:\s*([\s\S]+)$/m.exec(frame)?.[1];
      if (!ev || !dataLine) continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(dataLine) as Record<string, unknown>;
      } catch {
        continue;
      }
      // The last routing event wins: the server emits a second one when it
      // falls back to the labeled mock mid-request.
      if (ev === "routing") routing = data;
      else if (ev === "token") {
        if (ttftClientMs === null) ttftClientMs = Date.now() - t0;
        text += String(data.text ?? "");
      } else if (ev === "final") final = data;
      else if (ev === "error") errored = String(data.message ?? "error");
    }
  }
  return { text, ttftClientMs, totalMs: Date.now() - t0, routing, final, errored };
}

// --- quality --------------------------------------------------------------

function check(text: string, e: Expect): boolean {
  const body = text.trim();
  if (e.type === "contains") {
    const hay = e.caseSensitive === false ? body.toLowerCase() : body;
    const needle = e.caseSensitive === false ? String(e.value).toLowerCase() : String(e.value);
    return hay.includes(needle);
  }
  if (e.type === "regex") {
    const raw = String(e.value);
    const ci = raw.startsWith("(?i)");
    return new RegExp(ci ? raw.slice(4) : raw, ci ? "i" : undefined).test(body);
  }
  if (e.type === "json") {
    const stripped = body
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1) return false;
    try {
      const obj = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
      return (e.keys ?? []).every((k) => k in obj);
    } catch {
      return false;
    }
  }
  return false;
}

// --- main -----------------------------------------------------------------

function fmt(n: number | undefined, digits = 0): string {
  return n === undefined || Number.isNaN(n) ? "-" : n.toFixed(digits);
}

async function main(): Promise<void> {
  // Guard rails: with NODE_ENV=test or a forced mock the router never reaches a
  // real engine, and the harness would happily report the mock's latency.
  if (process.env.NODE_ENV === "test") throw new Error("refusing to run with NODE_ENV=test (forces the mock provider)");
  if (process.env.AI_PROVIDER_DEFAULT === "mock") throw new Error("refusing to run with AI_PROVIDER_DEFAULT=mock");

  const health = await req<{ status: string; version?: string }>("/health", "GET");
  if (health.status !== "ok") throw new Error(`API not healthy: ${JSON.stringify(health)}`);
  const router = await req<{ status: string }>("/health/ai-router", "GET");
  if (router.status !== "ok") {
    throw new Error(`ai-router is '${router.status}' — no local engine reachable, every run would measure the mock`);
  }

  const { accessToken } = await req<{ accessToken: string }>("/auth/login", "POST", {
    email: EMAIL,
    password: PASSWORD,
  });

  const available = await req<{ models: string[]; chatDefault: string | null }>(
    "/ai/models",
    "GET",
    undefined,
    accessToken,
  );
  const requested = (process.env.EVAL_MODELS ?? available.chatDefault ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (requested.length === 0) throw new Error("no models to evaluate (set EVAL_MODELS)");
  const missing = requested.filter((m) => !available.models.includes(m));
  if (missing.length > 0) {
    throw new Error(`models not served by any local engine: ${missing.join(", ")}`);
  }

  const dataset = JSON.parse(readFileSync(join(HERE, "eval", "dataset.json"), "utf8")) as {
    cases: Case[];
  };
  const only = (process.env.EVAL_CASES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const cases = only.length > 0 ? dataset.cases.filter((c) => only.includes(c.id)) : dataset.cases;
  if (cases.length === 0) throw new Error("no cases selected");

  const hw = hardwareProfile();
  const before = await residentModels();
  console.log(`Neurion eval — API ${API} (v${health.version ?? "?"})`);
  console.log(`  ${hw.cpu} · ${hw.threads}t · ${hw.ramFreeGb}/${hw.ramTotalGb} GB liberi · GPU: ${hw.gpu}`);
  console.log(`  residenti all'avvio: ${before.length ? before.map((m) => `${m.name}(${m.processor})`).join(", ") : "nessuno"}`);
  console.log(`  ${requested.length} modelli × ${cases.length} casi × ${RUNS} run (+1 cold scartato dalle medie)\n`);

  const results: RunResult[] = [];

  for (const model of requested) {
    console.log(`── ${model}`);
    // Only the very first request of a model pays the load: after that the
    // engine keeps it resident and every later "first run of a case" is warm.
    // Conflating the two hides the number this whole exercise is about.
    let firstOfModel = true;
    for (const c of cases) {
      for (let run = 0; run <= RUNS; run++) {
        const cold = firstOfModel;
        firstOfModel = false;
        const r: RunResult = { model, caseId: c.id, category: c.category, cold, valid: false };
        try {
          const s = await streamOnce(accessToken, model, c.prompt);
          const servedModel = String(s.routing?.model ?? "");
          const provider = String(s.routing?.provider ?? "");
          const labeled = s.routing?.labeled === true;
          const routeReason = String(s.routing?.routeReason ?? "");

          if (s.errored) r.invalidReason = `error: ${s.errored}`;
          else if (!s.final) r.invalidReason = "stream ended without final";
          else if (provider === "mock" || labeled) r.invalidReason = `mock fallback (${routeReason})`;
          else if (routeReason === "NO_ONLINE_ENGINE") r.invalidReason = "no online engine";
          else if (servedModel !== model) r.invalidReason = `served ${servedModel}, asked ${model}`;

          r.provider = provider;
          r.servedModel = servedModel;
          r.lane = String(s.routing?.lane ?? "");
          r.totalMs = s.totalMs;
          r.ttftClientMs = s.ttftClientMs ?? undefined;
          r.outputChars = s.text.length;

          if (!r.invalidReason) {
            r.valid = true;
            r.pass = check(s.text, c.expect);
            const serverTtft = Number((s.final as { firstTokenMs?: number })?.firstTokenMs ?? NaN);
            if (Number.isFinite(serverTtft)) {
              r.serverFirstTokenMs = serverTtft;
              if (r.ttftClientMs !== undefined) r.overheadMs = r.ttftClientMs - serverTtft;
            }
            const usage = (s.final as { tokenUsage?: { completionTokens?: number } })?.tokenUsage;
            r.completionTokens = usage?.completionTokens;
            r.genMs = r.ttftClientMs !== undefined ? s.totalMs - r.ttftClientMs : undefined;
            if (r.genMs && r.genMs > 0) {
              if (r.completionTokens) r.tokPerSec = (r.completionTokens / r.genMs) * 1000;
              r.charPerSec = (s.text.length / r.genMs) * 1000;
            }
          }
        } catch (e) {
          r.invalidReason = (e as Error).message.slice(0, 160);
        }
        results.push(r);

        const tag = cold ? "cold" : `run${run}`;
        if (r.valid) {
          console.log(
            `  ${r.pass ? "ok  " : "FAIL"} ${c.id.padEnd(22)} ${tag.padEnd(5)} ttft ${fmt(r.ttftClientMs)}ms  tot ${fmt(r.totalMs)}ms  ${fmt(r.tokPerSec, 1)} tok/s`,
          );
        } else {
          console.log(`  SKIP ${c.id.padEnd(22)} ${tag.padEnd(5)} ${r.invalidReason}`);
        }
      }
    }
    console.log("");
  }

  // --- summary ---
  const valid = results.filter((r) => r.valid);
  const warm = valid.filter((r) => !r.cold);
  const median = (xs: number[]): number | undefined => {
    const s = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (s.length === 0) return undefined;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1]! + s[m]!) / 2;
  };

  console.log("=== riepilogo (mediane sui run a caldo) ===");
  console.log(
    `${"modello".padEnd(30)} ${"ok".padEnd(7)} ${"ttft".padEnd(9)} ${"tot".padEnd(9)} ${"tok/s".padEnd(7)} 1a-req`,
  );
  const summaries: Record<string, unknown>[] = [];
  for (const model of requested) {
    const mw = warm.filter((r) => r.model === model);
    const mc = valid.filter((r) => r.model === model && r.cold);
    const passRate = mw.length ? mw.filter((r) => r.pass).length / mw.length : 0;
    const s = {
      model,
      samples: mw.length,
      passRate: +(passRate * 100).toFixed(0),
      ttftMedianMs: median(mw.map((r) => r.ttftClientMs!)),
      totalMedianMs: median(mw.map((r) => r.totalMs!)),
      tokPerSecMedian: median(mw.map((r) => r.tokPerSec!).filter(Boolean)),
      // Single sample by construction: the one request that paid the model load.
      coldTtftMs: median(mc.map((r) => r.ttftClientMs!)),
      overheadMedianMs: median(mw.map((r) => r.overheadMs!).filter((n) => Number.isFinite(n))),
      invalid: results.filter((r) => r.model === model && !r.valid).length,
    };
    summaries.push(s);
    console.log(
      `${model.padEnd(30)} ${`${s.passRate}%`.padEnd(7)} ${`${fmt(s.ttftMedianMs)}ms`.padEnd(9)} ${`${fmt(s.totalMedianMs)}ms`.padEnd(9)} ${fmt(s.tokPerSecMedian, 1).padEnd(7)} ${fmt(s.coldTtftMs)}ms`,
    );
  }

  const invalid = results.filter((r) => !r.valid);
  if (invalid.length > 0) {
    console.log(`\n${invalid.length} run non validi (esclusi dalle medie):`);
    const reasons = new Map<string, number>();
    for (const r of invalid) reasons.set(r.invalidReason ?? "?", (reasons.get(r.invalidReason ?? "?") ?? 0) + 1);
    for (const [why, n] of reasons) console.log(`  ${n}×  ${why}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, `eval-${stamp}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        api: API,
        apiVersion: health.version,
        hardware: hw,
        residentBefore: before,
        residentAfter: await residentModels(),
        runs: RUNS,
        dataset: cases.map((c) => c.id),
        summaries,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nscritto ${outFile}`);

  // A run that never reached a real engine is a failed measurement, not a slow one.
  if (valid.length === 0) {
    console.error("\nNESSUN run valido — la misura non ha prodotto nulla di utilizzabile.");
    process.exit(1);
  }
}

void main().catch((e) => {
  console.error(`eval failed: ${(e as Error).message}`);
  process.exit(1);
});
