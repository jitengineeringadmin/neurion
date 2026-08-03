// Update transport for the Neurion desktop app. Kept free of any Electron
// import so it can be unit-tested with plain Node (see scripts/updater-test.js).
//
// Deliberately not electron-updater: the electron-builder config excludes
// node_modules from the package (runtime deps are vendored into app-stack), so
// pulling in its transitive tree under pnpm is fragile. Built-ins only.
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

/**
 * Keys allowed to authorise a release, newest first.
 *
 * The bytes an update delivers are about to be EXECUTED, and until now the only
 * thing vouching for them was a digest that lived on the same web server as the
 * installer. Anyone able to write to that server could publish a binary and the
 * digest attesting to it, and every Neurion in the world would download and run
 * it. TLS does not help: TLS proves you reached the right server, not that the
 * right server is still honest.
 *
 * These keys never touch that server. The private half is generated once on the
 * release machine and stays in the maintainer's own profile, so a compromised
 * host can serve whatever it likes and cannot make it verify.
 *
 * A LIST, not a key, on purpose: it lets a spare be added in one release and the
 * old one dropped in the next, so a lost or rotated key never strands anybody
 * on a version that can no longer be updated.
 */
const RELEASE_KEYS = [
  'MCowBQYDK2VwAyEAzjLfvrXkzohEgQUkCUCDyIaiA5cloqglu9guVIPAmX0=',
];

/**
 * The exact bytes a release signature covers.
 *
 * Line-by-line rather than the JSON as it arrived: two encoders can disagree
 * about key order and whitespace, and a scheme that depends on somebody else's
 * formatting is one that eventually fails to verify for no reason at all.
 */
function releasePayload(m) {
  return `neurion-release-v1\n${m.version}\n${m.url}\n${String(m.sha256).toLowerCase()}\n`;
}

/**
 * Check a manifest against the release keys.
 *
 * An unsigned manifest is refused exactly like a forged one. Accepting it
 * "for compatibility" would mean an attacker only has to delete a field.
 */
function verifyManifest(manifest, keys = RELEASE_KEYS) {
  if (!manifest || typeof manifest.sig !== 'string' || !manifest.sig) {
    throw new Error('update manifest is not signed — refusing it');
  }
  const payload = Buffer.from(releasePayload(manifest));
  let sigBytes;
  try {
    sigBytes = Buffer.from(manifest.sig, 'base64');
  } catch {
    throw new Error('update manifest signature is not readable');
  }
  for (const k of keys) {
    try {
      const key = crypto.createPublicKey({
        key: Buffer.from(k, 'base64'),
        format: 'der',
        type: 'spki',
      });
      if (crypto.verify(null, payload, key, sigBytes)) return true;
    } catch {
      /* a key we cannot parse is simply not one that can vouch for this */
    }
  }
  throw new Error('update manifest signature does not match any release key');
}

/** Compare dotted numeric versions. >0 when `a` is newer than `b`. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** GET a URL as a Buffer, following redirects. */
function fetchBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    let mod;
    try {
      mod = new URL(url).protocol === 'http:' ? http : https;
    } catch (e) {
      return reject(e);
    }
    const req = mod.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(fetchBuffer(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Fetch + parse the publish manifest. Throws if it is not usable. */
async function fetchManifest(url, { keys = RELEASE_KEYS } = {}) {
  // Strip a UTF-8 BOM before parsing — plenty of Windows tooling emits one and
  // JSON.parse treats it as a syntax error.
  const text = (await fetchBuffer(url)).toString('utf8').replace(/^﻿/, '');
  const manifest = JSON.parse(text);
  if (!manifest || typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('manifest has no version');
  }
  if (typeof manifest.url !== 'string' || !manifest.url) {
    throw new Error('manifest has no url');
  }
  if (!manifest.sha256) {
    throw new Error('manifest has no sha256');
  }
  // Before anything else is believed about it, including the version: an
  // unverified manifest is a stranger's opinion about what this machine should
  // download and run.
  verifyManifest(manifest, keys);
  return manifest;
}

/**
 * Download the installer and verify it against the manifest digest. The bytes
 * are about to be EXECUTED: with no code-signing certificate, TLS plus this
 * checksum is the entire integrity story, so a missing digest is a hard error
 * rather than something to skip.
 */
async function downloadVerified(url, sha256, { allowInsecure = false } = {}) {
  if (!/^https:\/\//i.test(url) && !allowInsecure) {
    throw new Error(`refusing to download an update over a non-HTTPS URL: ${url}`);
  }
  if (!sha256) throw new Error('manifest has no sha256 — refusing to run the installer');
  const bin = await fetchBuffer(url);
  const got = crypto.createHash('sha256').update(bin).digest('hex');
  if (got.toLowerCase() !== String(sha256).toLowerCase()) {
    throw new Error(`checksum mismatch (expected ${sha256}, got ${got})`);
  }
  return bin;
}

module.exports = {
  compareVersions,
  fetchBuffer,
  fetchManifest,
  downloadVerified,
  verifyManifest,
  releasePayload,
  RELEASE_KEYS,
};
