/**
 * Publish a tagged release to neurionproject.org.
 *
 * What changes here, and why it matters more than convenience: until now the
 * binary on the website came from whatever was sitting in dist-installer on one
 * developer's machine. Nobody could check that it corresponded to any particular
 * commit, because nothing tied the two together. These artifacts come from the
 * GitHub Actions run for the tag, built from the tagged source on a machine
 * nobody logs into — so "the download matches the source" is a claim somebody
 * can actually verify.
 *
 * The signing step is unchanged and stays local: the private key never leaves
 * this machine, so a compromised web server can serve any file it wants and
 * still cannot produce a signature the app will accept.
 *
 *   node infra/publish-release.mjs v1.11.0
 *   node infra/publish-release.mjs v1.11.0 --dry-run
 */
import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  sign as signBuffer,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const HOST = "root@80.211.141.173";
const REMOTE_DIR = "/var/www/neurion/download";
const KEY_PATH = join(homedir(), ".neurion", "release-key.json");
const SSH_KEY = join(homedir(), ".ssh", "github_actions_sapius");

const tag = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error("usage: node infra/publish-release.mjs v1.2.3 [--dry-run]");
  process.exit(2);
}
const version = tag.slice(1);

/**
 * Each artifact and the stable name the site links to. The website never has to
 * be edited for a release: the -latest name is repointed here instead.
 *
 * `required` separates "the build is broken" from "that platform did not
 * produce one this time" — a missing .exe should stop the publish; a missing
 * .deb should be reported and not stop it.
 */
const ARTIFACTS = [
  { file: `Neurion-Setup-${version}.exe`, latest: "Neurion-Setup-latest.exe", required: true, updater: true },
  { file: `Neurion-${version}-mac-arm64.dmg`, latest: "Neurion-latest.dmg", required: false },
  { file: `Neurion-${version}-linux-x86_64.AppImage`, latest: "Neurion-latest.AppImage", required: false },
  { file: `Neurion-${version}-linux-amd64.deb`, latest: "Neurion-latest.deb", required: false },
];

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

const ssh = (script) => run("ssh", ["-i", SSH_KEY, "-o", "StrictHostKeyChecking=no", HOST, script]);
const scp = (local, remote) =>
  run("scp", ["-i", SSH_KEY, "-o", "StrictHostKeyChecking=no", local, `${HOST}:${remote}`]);

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

// ---- 1. fetch the artifacts the tagged build produced ----------------------
const work = join(tmpdir(), `neurion-release-${version}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
console.log(`fetching ${tag} artifacts into ${work}`);
run("gh", ["release", "download", tag, "--dir", work, "--clobber"], { stdio: "inherit" });

const present = [];
for (const a of ARTIFACTS) {
  const path = join(work, a.file);
  if (!existsSync(path)) {
    if (a.required) throw new Error(`${a.file} is missing from ${tag} — the build did not produce it`);
    console.log(`  absent: ${a.file} (not published this time)`);
    continue;
  }
  // A truncated download would otherwise be signed and shipped without comment.
  const size = statSync(path).size;
  if (size < 1_000_000) throw new Error(`${a.file} is only ${size} bytes — refusing to publish it`);
  present.push({ ...a, path, size, hash: sha256(path) });
}

console.log("");
for (const a of present) {
  console.log(`  ${a.file}  ${(a.size / 1e6).toFixed(1)} MB  ${a.hash.slice(0, 16)}…`);
}

const win = present.find((a) => a.updater);
if (!win) throw new Error("no Windows installer — nothing to sign a manifest for");

// ---- 2. build and sign the manifest, here, never on the server -------------
// The signed payload is unchanged from v1: installs already in the field must
// keep verifying it, and a format change would strand every one of them.
const manifest = {
  version,
  url: win.file,
  sha256: win.hash,
  notes: `Neurion ${version}`,
};
const pair = JSON.parse(readFileSync(KEY_PATH, "utf8"));
const privateKey = createPrivateKey({
  key: Buffer.from(pair.privateKey, "base64"),
  format: "der",
  type: "pkcs8",
});
const payload = `neurion-release-v1\n${manifest.version}\n${manifest.url}\n${manifest.sha256}\n`;
manifest.sig = signBuffer(null, Buffer.from(payload), privateKey).toString("base64");
const manifestPath = join(work, "latest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
console.log(`\nmanifest signed for ${version}`);

if (dryRun) {
  console.log("\n--dry-run: nothing was uploaded");
  console.log(readFileSync(manifestPath, "utf8"));
  process.exit(0);
}

// ---- 3. upload, then repoint the stable names -----------------------------
for (const a of present) {
  console.log(`uploading ${a.file}…`);
  scp(a.path, `${REMOTE_DIR}/${a.file}`);
}
// The manifest goes last on purpose: it is what tells every installed copy that
// a new version exists, so it must not name a file that is still uploading.
scp(manifestPath, `${REMOTE_DIR}/latest.json`);

const links = present.map((a) => `cp -f '${a.file}' '${a.latest}'`).join("; ");
const owned = [...present.map((a) => a.file), ...present.map((a) => a.latest), "latest.json"]
  .map((f) => `'${f}'`)
  .join(" ");
ssh(
  `set -e; cd ${REMOTE_DIR}; ${links}; chown www-data:www-data ${owned}; ` +
    `if [ -f /var/www/neurion/index.html ]; then ` +
    `sed -Ei 's/v[0-9]+\\.[0-9]+\\.[0-9]+/v${version}/g' /var/www/neurion/index.html; ` +
    `chown www-data:www-data /var/www/neurion/index.html; fi`,
);

// ---- 4. check what the world actually gets --------------------------------
console.log("\nverifying over HTTPS:");
for (const a of present) {
  const head = run("curl", ["-sSI", "--max-time", "30", `https://neurionproject.org/download/${a.latest}`]);
  const code = head.split("\n")[0].trim();
  const len = /content-length:\s*(\d+)/i.exec(head)?.[1];
  const ok = Number(len) === a.size;
  console.log(`  ${a.latest.padEnd(28)} ${code}  ${ok ? "size matches" : `SIZE MISMATCH (${len} vs ${a.size})`}`);
  if (!ok) process.exitCode = 1;
}
const served = JSON.parse(run("curl", ["-sS", "--max-time", "30", "https://neurionproject.org/download/latest.json"]));
console.log(`  latest.json                  version ${served.version}, sig ${served.sig === manifest.sig ? "matches" : "DIFFERS"}`);
if (served.version !== version || served.sig !== manifest.sig) process.exitCode = 1;

console.log(`\npublished ${version}`);
