// Update transport for the Neurion desktop app. Kept free of any Electron
// import so it can be unit-tested with plain Node (see scripts/updater-test.js).
//
// Deliberately not electron-updater: the electron-builder config excludes
// node_modules from the package (runtime deps are vendored into app-stack), so
// pulling in its transitive tree under pnpm is fragile. Built-ins only.
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

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
async function fetchManifest(url) {
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

module.exports = { compareVersions, fetchBuffer, fetchManifest, downloadVerified };
