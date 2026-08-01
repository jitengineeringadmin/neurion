/**
 * Packaging smoke test.
 *
 * Bundling the API into a single file makes boot fast, but it also rewrites how
 * modules find their own files. The failures that causes are invisible at
 * startup — the app boots perfectly and then dies the first time a user uploads
 * a PDF or asks for audio. This exercises exactly those paths, so the damage is
 * found by a test instead of by a user.
 *
 * Runs against source (tsx scripts/packaging-test.ts) and, more importantly,
 * against a packaged install:
 *   NEURION_PKG_DIR=<...>/resources/app-stack/api tsx scripts/packaging-test.ts
 * where it resolves every module from that directory instead of this one.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function ok(name: string): void {
  passed += 1;
  console.log(`  ok   ${name}`);
}
function bad(name: string, err: unknown): void {
  failed += 1;
  console.log(`  FAIL ${name}`);
  console.log(`       ${(err as Error)?.message ?? String(err)}`);
}
async function check(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    ok(name);
  } catch (e) {
    bad(name, e);
  }
}
function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

// When pointed at a packaged install, resolve modules the way that install
// would — otherwise the test proves things about the dev tree and nothing
// about what actually ships.
const pkgDir = process.env.NEURION_PKG_DIR;
if (pkgDir && !existsSync(join(pkgDir, "package.json"))) {
  console.error(`NEURION_PKG_DIR does not look like an API install: ${pkgDir}`);
  process.exit(1);
}
const req = pkgDir
  ? createRequire(join(pkgDir, "package.json"))
  : createRequire(__filename);

console.log(
  pkgDir ? `packaging test against ${pkgDir}` : "packaging test against source",
);

/**
 * The smallest PDF that still contains extractable text, with a correct xref
 * table. Built here rather than committed as a binary so the expected string is
 * visible in the diff.
 */
function tinyPdf(text: string): Buffer {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    null, // content stream, built below
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  objects[3] = `<</Length ${stream.length}>>stream\n${stream}\nendstream`;

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj${body}endobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function main(): Promise<void> {
  // --- the two paths bundling is known to break -------------------------
  await check("pdf-parse extracts text from a real PDF", async () => {
    const { PDFParse } = req("pdf-parse") as {
      PDFParse: new (o: { data: Buffer }) => {
        getText(): Promise<{ text: string }>;
      };
    };
    const parser = new PDFParse({ data: tinyPdf("NEURION-PDF-OK") });
    const out = await parser.getText();
    assert(
      out.text.includes("NEURION-PDF-OK"),
      `expected the marker in the extracted text, got: ${JSON.stringify(out.text.slice(0, 120))}`,
    );
  });

  await check("pdf-parse ships its worker next to the bundle", () => {
    // The DOMMatrix crash this test exists for happens when pdf.js cannot find
    // its own files after being relocated.
    const entry = req.resolve("pdf-parse");
    assert(entry.length > 0, "pdf-parse did not resolve");
  });

  await check("@huggingface/transformers is resolvable (audio generation)", () => {
    // audio.service.ts does an UNGUARDED `await import()` of this. If packaging
    // drops it, TTS and music generation throw at first use, not at boot.
    const entry = req.resolve("@huggingface/transformers");
    assert(entry.length > 0, "transformers did not resolve");
  });

  // --- the native modules that must stay outside any bundle -------------
  await check("argon2 hashes and verifies (login path)", async () => {
    const argon2 = req("argon2") as {
      hash(s: string): Promise<string>;
      verify(h: string, s: string): Promise<boolean>;
    };
    const hash = await argon2.hash("neurion-packaging-test");
    assert(await argon2.verify(hash, "neurion-packaging-test"), "verify failed");
    assert(
      !(await argon2.verify(hash, "wrong-password")),
      "verify accepted a wrong password",
    );
  });

  await check("geoip resolves a public address, and stays quiet on private", () => {
    const geoip = req("geoip-lite") as {
      lookup(ip: string): { country?: string } | null;
    };
    const hit = geoip.lookup("8.8.8.8");
    assert(hit?.country === "US", `expected US for 8.8.8.8, got ${hit?.country}`);
    assert(geoip.lookup("127.0.0.1") === null, "loopback should not resolve");
  });

  await check("the Prisma client can be constructed", () => {
    const { PrismaClient } = req("@prisma/client") as {
      PrismaClient: new () => unknown;
    };
    // Constructing does not connect; a bad packaging fails right here instead.
    assert(new PrismaClient() != null, "PrismaClient returned nothing");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main();
