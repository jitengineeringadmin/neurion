/**
 * Sign the update manifest with a key that does not live on the web server.
 *
 * The problem this closes: the app checked the installer against a sha256 taken
 * from latest.json, and latest.json sat on the same host as the installer.
 * That catches a corrupted download and nothing else — anyone who could write
 * to the web root could publish a binary AND the digest vouching for it, and
 * every Neurion in the world would download and run it.
 *
 * With this, the digest is signed by a key that has never been on that server.
 * A compromised host can serve whatever it likes; it cannot produce a signature
 * for it, and the app refuses anything it cannot verify.
 *
 * The private key is generated once, kept outside the repository in the user's
 * own profile, and never travels. LOSING IT MEANS NO MORE UPDATES FOR ANYONE —
 * so it is printed once with a plain instruction to back it up, and the app
 * accepts a list of keys rather than one, so a spare can be added later without
 * anybody being stranded.
 *
 *   node infra/sign-manifest.mjs <path-to-latest.json>
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";

const KEY_DIR = join(homedir(), ".neurion");
const KEY_PATH = join(KEY_DIR, "release-key.json");

/**
 * The exact bytes that get signed.
 *
 * A fixed line-by-line shape rather than JSON: two JSON encoders can disagree
 * about key order and spacing, and a signature scheme that depends on somebody
 * else's formatting is a signature scheme that eventually fails to verify for
 * no reason at all.
 */
export function releasePayload(m) {
  return `neurion-release-v1\n${m.version}\n${m.url}\n${String(m.sha256).toLowerCase()}\n`;
}

function loadOrCreateKey() {
  if (existsSync(KEY_PATH)) {
    const saved = JSON.parse(readFileSync(KEY_PATH, "utf8"));
    if (!saved.privateKey || !saved.publicKey) {
      throw new Error(`${KEY_PATH} exists but is not a key pair`);
    }
    return saved;
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pair = {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    created: new Date().toISOString(),
  };
  mkdirSync(KEY_DIR, { recursive: true });
  writeFileSync(KEY_PATH, JSON.stringify(pair, null, 2));
  try {
    chmodSync(KEY_PATH, 0o600);
  } catch {
    /* Windows: the file sits in the user's own profile */
  }
  console.log("");
  console.log("  A NEW RELEASE KEY WAS CREATED");
  console.log(`  private key: ${KEY_PATH}  <- back this up somewhere safe`);
  console.log("  If it is lost, nobody can be sent another update, ever.");
  console.log("  It must never be committed and never be copied to the server.");
  console.log("");
  console.log("  Put this public key in apps/desktop/updater.js (RELEASE_KEYS):");
  console.log(`  ${pair.publicKey}`);
  console.log("");
  return pair;
}

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error("usage: node infra/sign-manifest.mjs <path-to-latest.json>");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^﻿/, ""));
for (const field of ["version", "url", "sha256"]) {
  if (!manifest[field]) throw new Error(`manifest has no ${field}`);
}

const pair = loadOrCreateKey();
const key = createPrivateKey({
  key: Buffer.from(pair.privateKey, "base64"),
  format: "der",
  type: "pkcs8",
});
manifest.sig = sign(null, Buffer.from(releasePayload(manifest)), key).toString("base64");

// Written without a BOM: the updater strips one, but plenty of other things
// would not.
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: "utf8" });
console.log(`signed ${manifest.version} with the release key`);
