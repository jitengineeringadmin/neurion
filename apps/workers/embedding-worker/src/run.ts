// embedding.v1 worker (skeleton — Agent 07). Deterministic placeholder so the
// pipeline + G1 sanity (dim, finite, non-zero) can be exercised before a real model.
// Contract: /worker/run --input /job/input.json --output /job/output.json
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Placeholder embedding: hash-seeded pseudo-vector. NOT a real model — replaced in Agent 07.
function placeholderEmbed(text: string, dim: number): number[] {
  const v: number[] = [];
  let seed = createHash('sha256').update(text).digest();
  let i = 0;
  while (v.length < dim) {
    if (i >= seed.length) {
      seed = createHash('sha256').update(seed).digest();
      i = 0;
    }
    v.push((seed[i]! / 255) * 2 - 1);
    i++;
  }
  return v;
}

function main(): void {
  const inputPath = arg('--input') ?? '/job/input.json';
  const outputPath = arg('--output') ?? '/job/output.json';
  const startedAt = new Date().toISOString();

  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as { text?: string; dim?: number };
  const dim = input.dim ?? 384;
  const vector = placeholderEmbed(input.text ?? '', dim);
  const completedAt = new Date().toISOString();

  const output = {
    success: true,
    result: { vector, dim },
    metrics: {
      startedAt,
      completedAt,
      durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    },
  };
  writeFileSync(outputPath, JSON.stringify(output));
  // eslint-disable-next-line no-console
  console.log(`embedding.v1 (placeholder) done dim=${dim} -> ${outputPath}`);
}

main();
