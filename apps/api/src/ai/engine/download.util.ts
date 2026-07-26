import {
  createWriteStream,
  rmSync,
  renameSync,
  existsSync,
  statSync,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Streaming download with an atomic finish.
 *
 * Modelled on the image engine's downloader (image.controller.ts), which is in
 * production and works, with three defects fixed rather than inherited:
 *   - progress fired once per chunk, flooding an SSE stream with thousands of
 *     near-identical frames; it now fires only when the whole percent changes
 *   - a response without content-length reported 0% forever with no explanation;
 *     the caller is now told the size is unknown
 *   - completeness was judged only against content-length; a caller can now also
 *     assert an expected size, which is what catches an HTML error page saved
 *     under a .gguf name
 *
 * The file is written to `<out>.part` and renamed only once complete, so an
 * interrupted download never leaves a truncated file that looks installed.
 */
export async function downloadFile(
  url: string,
  out: string,
  onProgress?: (
    percent: number,
    receivedBytes: number,
    totalBytes: number | null,
  ) => void,
  opts: { expectedBytes?: number; toleranceRatio?: number } = {},
): Promise<number> {
  const tmp = `${out}.part`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`download failed HTTP ${res.status} for ${url}`);
  }

  const declared = Number(res.headers.get("content-length") || 0);
  const total = declared > 0 ? declared : null;
  let received = 0;
  let lastPercent = -1;

  const stream = Readable.fromWeb(res.body as never);
  stream.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (!onProgress) return;
    const percent = total ? Math.floor((received / total) * 100) : -1;
    // One event per whole percent — a 4 GB model is ~30k chunks otherwise.
    if (percent !== lastPercent) {
      lastPercent = percent;
      onProgress(percent, received, total);
    }
  });

  try {
    await pipeline(stream, createWriteStream(tmp));

    if (total !== null && received < total * 0.99) {
      throw new Error(`download incomplete: ${received} of ${total} bytes`);
    }
    const expected = opts.expectedBytes;
    if (expected) {
      const tolerance = opts.toleranceRatio ?? 0.9;
      if (received < expected * tolerance) {
        throw new Error(
          `download too small: ${received} bytes, expected about ${expected}`,
        );
      }
    }

    rmSync(out, { force: true });
    renameSync(tmp, out);
    return received;
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** True when a file exists and is at least `minBytes` — a 0-byte or truncated leftover is not "installed". */
export function fileReady(path: string, minBytes = 1): boolean {
  try {
    return existsSync(path) && statSync(path).size >= minBytes;
  } catch {
    return false;
  }
}
