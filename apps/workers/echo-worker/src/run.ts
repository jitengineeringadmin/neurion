// echo.v1 worker — full-pipeline validation worker (spec §13).
// Contract: /worker/run --input /job/input.json --output /job/output.json
import { readFileSync, writeFileSync } from 'node:fs';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const inputPath = arg('--input') ?? '/job/input.json';
  const outputPath = arg('--output') ?? '/job/output.json';

  const startedAt = new Date().toISOString();
  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as { text?: string };
  const result = { echo: input.text ?? '' };
  const completedAt = new Date().toISOString();

  const output = {
    success: true,
    result,
    metrics: {
      startedAt,
      completedAt,
      durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      memoryPeakMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    },
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  // eslint-disable-next-line no-console
  console.log(`echo.v1 done -> ${outputPath}`);
}

main();
