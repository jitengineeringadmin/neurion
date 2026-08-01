/**
 * Bundle the compiled API into a single file.
 *
 * Why: starting the packaged API opened 1,720 files and compiled 1,707 modules
 * before Nest logged its first line. On a machine with real-time antivirus and a
 * cold file cache that cost 93 seconds; the application itself boots in one.
 * Bundling takes it to 21 files and 17 module loads.
 *
 * What stays outside, and why each one has to:
 *   - native binaries (.node) cannot be inlined at all;
 *   - packages that locate their own data files relative to __dirname break when
 *     moved — geoip's datasets, Prisma's query engine, pdf.js's worker;
 *   - Nest probes for optional peers it does not have, so those must not be
 *     resolved eagerly by the bundler.
 *
 * pdf-parse is external for a specific, tested reason: bundled, webpack rewrote
 * its internal require of @napi-rs/canvas so the polyfill was skipped, and the
 * process died with "DOMMatrix is not defined" BEFORE Nest started. That failure
 * is invisible to a boot check but breaks every PDF a user attaches.
 *
 * Run after `nest build`:  node scripts/bundle.mjs
 */
import { build } from "esbuild";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(API_DIR, "dist", "main.js");
const OUT = join(API_DIR, "dist-bundle", "main.js");

/** Everything that must keep resolving from node_modules at runtime. */
export const EXTERNALS = [
  // native addons + the packages that load them
  "argon2",
  "sharp",
  "@napi-rs/canvas",
  "onnxruntime-node",
  // generated client + query engine, found by absolute path
  "@prisma/client",
  ".prisma/client",
  "@prisma/engines",
  "prisma",
  // reads its 109 MB dataset relative to its own directory
  "geoip-lite",
  // pdf.js locates its worker relative to itself; bundling it crashes at boot
  "pdf-parse",
  "pdfjs-dist",
  // optional, loaded through a variable import when audio generation is used
  "@huggingface/transformers",
  // optional peers Nest/express/ws probe for and expect to be absent
  "@nestjs/microservices",
  "@nestjs/microservices/microservices-module",
  "@nestjs/websockets",
  "@nestjs/websockets/socket-module",
  "cache-manager",
  "bufferutil",
  "utf-8-validate",
];

if (!existsSync(ENTRY)) {
  console.error(`no compiled entry at ${ENTRY} — run \`nest build\` first`);
  process.exit(1);
}

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: OUT,
  external: EXTERNALS,
  logLevel: "warning",
  logLimit: 0,
  // Nest reads decorator metadata off the emitted classes; keeping names intact
  // is what makes that survive bundling.
  keepNames: true,
});

if (result.errors.length) process.exit(1);

const mb = (statSync(OUT).size / 1024 / 1024).toFixed(2);
console.log(`bundled -> ${OUT} (${mb} MB, ${EXTERNALS.length} externals)`);
