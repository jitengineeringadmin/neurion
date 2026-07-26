// Pure verification helpers + tuned constants (red-team-hardened).

export const COSINE_TOLERANCE = 0.9995; // embedding deep-verify floor (0.999 leaked scaled cheaper-model output)
export const NORM_RATIO_BAND: readonly [number, number] = [0.97, 1.03]; // cosine is scale-invariant; norm catches scaled fakes
export const HIGH_VALUE_THRESHOLD = 25; // reward >= this => always deep-verified (100% sample)
export const SAMPLE_BASE = 0.15; // base audit rate at reputation 0
export const SAMPLE_FLOOR = 0.03; // permanent spot-check rate (fail-safe-up)
export const PROBATION_DEEP_PASSES = 30; // deep-PASSes needed to graduate PROBATION
export const EWMA_ALPHA = 0.1; // reputation move per deep-verified outcome
export const RETRO_AUDIT_WINDOW = 50; // (next slice) prior unsampled jobs to re-audit on a deep-FAIL

/** Protocol take-rate: the fee (in credits) Neurion keeps from a gross node reward. */
export function protocolFee(gross: number, bps: number): number {
  if (gross <= 0 || bps <= 0) return 0;
  return Math.floor((gross * bps) / 10_000);
}

export function l2norm(v: readonly number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

/** Cosine similarity; -1 on shape mismatch / zero vector. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? -1 : dot / denom;
}

/** EWMA reputation update on a *measured* (deep-verified) outcome only. */
export function ewma(prev: number, outcome: 0 | 1, alpha = EWMA_ALPHA): number {
  return (1 - alpha) * prev + alpha * outcome;
}

export interface Replica {
  nodeId: string;
  result: Record<string, unknown>;
}
export interface Consensus {
  agreed: boolean; // a strict majority (> K/2) agreed
  majority: string[]; // nodeIds in the winning cluster
  outliers: string[]; // nodeIds that disagreed (candidates for slashing)
}

/**
 * K-replica consensus: cluster K independent results, return the strict-majority
 * cluster and the outliers. echo = exact string equality; embedding = cosine
 * clustering at the deep-verify tolerance. No strict majority => not agreed
 * (escalate to the trusted L3 executor instead of paying anyone).
 */
export function consensus(
  jobType: string,
  replicas: readonly Replica[],
): Consensus {
  const k = replicas.length;
  if (k === 0) return { agreed: false, majority: [], outliers: [] };

  const clusters: { rep: Replica; members: string[] }[] = [];
  const sameCluster = (a: Replica, b: Replica): boolean => {
    if (jobType === "echo.v1") return a.result.echo === b.result.echo;
    if (jobType === "embedding.v1") {
      const va = a.result.vector as number[] | undefined;
      const vb = b.result.vector as number[] | undefined;
      if (!Array.isArray(va) || !Array.isArray(vb)) return false;
      return cosine(va, vb) >= COSINE_TOLERANCE;
    }
    return JSON.stringify(a.result) === JSON.stringify(b.result);
  };

  for (const r of replicas) {
    const c = clusters.find((cl) => sameCluster(cl.rep, r));
    if (c) c.members.push(r.nodeId);
    else clusters.push({ rep: r, members: [r.nodeId] });
  }
  clusters.sort((a, b) => b.members.length - a.members.length);
  const top = clusters[0]!;
  const agreed = top.members.length > k / 2; // strict majority
  const majority = agreed ? top.members : [];
  const outliers = agreed ? clusters.slice(1).flatMap((c) => c.members) : [];
  return { agreed, majority, outliers };
}

/** Deep-compare a node's embedding output against the trusted reference. */
export function embeddingMatches(
  out: readonly number[],
  ref: readonly number[],
): { ok: boolean; cos: number; normRatio: number } {
  const cos = cosine(out, ref);
  const refNorm = l2norm(ref);
  const normRatio = refNorm === 0 ? 0 : l2norm(out) / refNorm;
  const ok =
    cos >= COSINE_TOLERANCE &&
    normRatio >= NORM_RATIO_BAND[0] &&
    normRatio <= NORM_RATIO_BAND[1];
  return { ok, cos, normRatio };
}
