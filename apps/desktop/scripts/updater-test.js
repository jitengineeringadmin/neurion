/**
 * Tests for the desktop update transport. Runs a throwaway HTTP server and
 * exercises the real code path — version comparison, manifest validation,
 * redirects, and the checksum gate that stands between a downloaded blob and
 * an executed installer.
 *
 * Run: node apps/desktop/scripts/updater-test.js
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const { compareVersions, fetchManifest, downloadVerified } = require('../updater');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}
async function rejects(fn, re, msg) {
  try {
    await fn();
  } catch (e) {
    assert.match(e.message, re, msg);
    return;
  }
  throw new Error(`${msg}: expected a rejection, got success`);
}

// --- version comparison ---------------------------------------------------
test('newer patch is an update', () => assert.ok(compareVersions('1.8.8', '1.8.7') > 0));
test('same version is not an update', () => assert.equal(compareVersions('1.8.8', '1.8.8'), 0));
test('older version is not an update', () => assert.ok(compareVersions('1.8.7', '1.8.8') < 0));
test('minor bump beats patch (1.9.0 > 1.8.99)', () =>
  assert.ok(compareVersions('1.9.0', '1.8.99') > 0));
test('major bump is an update (2.0.0 > 1.8.8)', () =>
  assert.ok(compareVersions('2.0.0', '1.8.8') > 0));
test('shorter version compares by position (1.9 > 1.8.8)', () =>
  assert.ok(compareVersions('1.9', '1.8.8') > 0));
test('numeric compare, not lexicographic (1.10.0 > 1.9.0)', () =>
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0));

void (async () => {
  const INSTALLER = Buffer.from('pretend this is Neurion-Setup.exe');
  const DIGEST = crypto.createHash('sha256').update(INSTALLER).digest('hex');

  const server = http.createServer((req, res) => {
    if (req.url === '/latest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ version: '9.9.9', url: 'Neurion-Setup-9.9.9.exe', sha256: DIGEST }));
    }
    if (req.url === '/bad.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ notes: 'no version here' }));
    }
    if (req.url === '/Neurion-Setup-9.9.9.exe') {
      res.writeHead(200);
      return res.end(INSTALLER);
    }
    if (req.url === '/redirect.exe') {
      res.writeHead(302, { location: '/Neurion-Setup-9.9.9.exe' });
      return res.end();
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const insecure = { allowInsecure: true };

  await testAsync('manifest is fetched and parsed', async () => {
    const m = await fetchManifest(`${base}/latest.json`);
    assert.equal(m.version, '9.9.9');
    assert.equal(m.sha256, DIGEST);
  });

  await testAsync('a manifest without a version is rejected', () =>
    rejects(() => fetchManifest(`${base}/bad.json`), /no version/, 'bad manifest'));

  await testAsync('a missing manifest is rejected', () =>
    rejects(() => fetchManifest(`${base}/nothing.json`), /HTTP 404/, 'missing manifest'));

  await testAsync('a matching checksum downloads the installer', async () => {
    const bin = await downloadVerified(`${base}/Neurion-Setup-9.9.9.exe`, DIGEST, insecure);
    assert.deepEqual(bin, INSTALLER);
  });

  await testAsync('redirects are followed', async () => {
    const bin = await downloadVerified(`${base}/redirect.exe`, DIGEST, insecure);
    assert.deepEqual(bin, INSTALLER);
  });

  await testAsync('SECURITY: a tampered installer is rejected', () =>
    rejects(
      () => downloadVerified(`${base}/Neurion-Setup-9.9.9.exe`, 'a'.repeat(64), insecure),
      /checksum mismatch/,
      'tampered binary',
    ));

  await testAsync('SECURITY: a manifest with no sha256 is rejected', () =>
    rejects(
      () => downloadVerified(`${base}/Neurion-Setup-9.9.9.exe`, undefined, insecure),
      /no sha256/,
      'unsigned manifest',
    ));

  await testAsync('SECURITY: a plain-HTTP update URL is refused by default', () =>
    rejects(
      () => downloadVerified(`${base}/Neurion-Setup-9.9.9.exe`, DIGEST),
      /non-HTTPS/,
      'http download',
    ));

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
