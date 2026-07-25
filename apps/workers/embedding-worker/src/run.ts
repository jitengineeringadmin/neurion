// embedding.v1 worker — REAL local sentence embeddings (all-MiniLM-L6-v2, 384-dim),
// mean-pooled + L2-normalized. Runs fully offline: the model is baked into the
// image at build time (the job sandbox runs with --network none).
// Contract: --input /job/input.json --output /job/output.json
import { readFileSync, writeFileSync } from 'node:fs';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const inputPath = arg('--input') ?? '/job/input.json';
  const outputPath = arg('--output') ?? '/job/output.json';
  const startedAt = new Date().toISOString();

  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as { text?: string };
  const text = input.text ?? '';

  // transformers.js is ESM-only — load it dynamically from this CJS module.
  const tf = await import('@xenova/transformers');
  tf.env.cacheDir = process.env.TRANSFORMERS_CACHE ?? '/worker/.models';
  // Sandbox runtime is offline; only the build step sets EMBED_ALLOW_REMOTE=true.
  tf.env.allowRemoteModels = process.env.EMBED_ALLOW_REMOTE === 'true';

  const extractor = await tf.pipeline('feature-extraction', MODEL);
  const out = await extractor(text, { pooling: 'mean', normalize: true });
  const vector = Array.from(out.data as Float32Array);
  const completedAt = new Date().toISOString();

  writeFileSync(
    outputPath,
    JSON.stringify({
      success: true,
      result: { vector, dim: vector.length, model: MODEL },
      metrics: {
        startedAt,
        completedAt,
        durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      },
    }),
  );
  // eslint-disable-next-line no-console
  console.log(`embedding.v1 (${MODEL}) done dim=${vector.length} -> ${outputPath}`);
}

main().catch((e) => {
  const outputPath = arg('--output') ?? '/job/output.json';
  try {
    writeFileSync(outputPath, JSON.stringify({ success: false, error: (e as Error).message }));
  } catch {
    /* ignore */
  }
  // eslint-disable-next-line no-console
  console.error('embedding.v1 failed:', (e as Error).message);
  process.exit(1);
});
