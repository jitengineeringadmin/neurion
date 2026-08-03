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
const {
  compareVersions,
  fetchManifest,
  downloadVerified,
  verifyManifest,
  releasePayload,
} = require('../updater');

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
/** Sync counterpart of `rejects`: the call must throw, with a matching message. */
function throws(fn, re, msg) {
  try {
    fn();
  } catch (e) {
    assert.match(e.message, re, msg);
    return;
  }
  throw new Error(`${msg}: expected a refusal, got success`);
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
      return res.end(JSON.stringify(signedManifest({ sha256: DIGEST })));
    }
    if (req.url === '/unsigned.json') {
      // What a compromised web server would serve: real-looking, unsigned.
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({ version: '9.9.9', url: 'Neurion-Setup-9.9.9.exe', sha256: DIGEST }),
      );
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

  await testAsync('manifest is fetched, verified and parsed', async () => {
    const m = await fetchManifest(`${base}/latest.json`, { keys: [releasePub] });
    assert.equal(m.version, '9.9.9');
    assert.equal(m.sha256, DIGEST);
  });

  await testAsync('a manifest without a version is rejected', () =>
    rejects(
      () => fetchManifest(`${base}/bad.json`, { keys: [releasePub] }),
      /no version/,
      'bad manifest',
    ));

  await testAsync('an unsigned manifest is refused over the wire too', () =>
    rejects(
      () => fetchManifest(`${base}/unsigned.json`, { keys: [releasePub] }),
      /not signed/,
      'unsigned manifest served by a compromised host',
    ));

  await testAsync('a missing manifest is rejected', () =>
    rejects(
      () => fetchManifest(`${base}/nothing.json`, { keys: [releasePub] }),
      /HTTP 404/,
      'missing manifest',
    ));

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

// --- the update channel, which was the last thing with a single owner -------
//
// Until this existed, the only thing vouching for an installer was a digest
// that lived on the same web server as the installer. That catches a corrupted
// download and nothing else: anyone able to write to the web root could publish
// a binary AND the digest attesting to it, and every Neurion in the world would
// fetch it and run it. TLS does not help — it proves you reached the right
// server, not that the right server is still honest.
//
// So these tests are about what must be REFUSED. A signature scheme that only
// gets tested on the happy path is a signature scheme nobody has tested.

const releaseKey = crypto.generateKeyPairSync('ed25519');
const releasePub = releaseKey.publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64');
const otherKey = crypto.generateKeyPairSync('ed25519');

function signedManifest(fields, key = releaseKey.privateKey) {
  const m = {
    version: '9.9.9',
    url: 'Neurion-Setup-9.9.9.exe',
    sha256: 'a'.repeat(64),
    ...fields,
  };
  m.sig = crypto.sign(null, Buffer.from(releasePayload(m)), key).toString('base64');
  return m;
}

test('a properly signed manifest is accepted', () => {
  assert.equal(verifyManifest(signedManifest({}), [releasePub]), true);
});

test('an unsigned manifest is refused', () => {
  const m = signedManifest({});
  delete m.sig;
  throws(() => verifyManifest(m, [releasePub]), /not signed/i,
    'a manifest with no signature must not be trusted — otherwise an attacker only has to delete a field');
});

test('a manifest signed by somebody else is refused', () => {
  const m = signedManifest({}, otherKey.privateKey);
  throws(() => verifyManifest(m, [releasePub]), /does not match/i,
    'any key must not do; only a release key');
});

test('changing the digest after signing is caught', () => {
  const m = signedManifest({});
  m.sha256 = 'b'.repeat(64);
  throws(() => verifyManifest(m, [releasePub]), /does not match/i,
    'the digest is the whole point: it must be inside the signature');
});

test('changing the download url after signing is caught', () => {
  const m = signedManifest({});
  m.url = 'https://example.invalid/evil.exe';
  throws(() => verifyManifest(m, [releasePub]), /does not match/i,
    'a signed digest is no use if the file it points at can be swapped');
});

test('replaying an old signature under a new version is caught', () => {
  const m = signedManifest({});
  m.version = '1.0.0';
  throws(() => verifyManifest(m, [releasePub]), /does not match/i,
    'the version is signed too, so an old release cannot be dressed up as a new one');
});

test('a spare key in the list also works', () => {
  // Rotation: a new key ships alongside the old one, so nobody is stranded on
  // a version that can no longer be updated.
  const m = signedManifest({}, otherKey.privateKey);
  const otherPub = otherKey.publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  assert.equal(verifyManifest(m, [releasePub, otherPub]), true);
});

test('rubbish in the signature field does not crash the check', () => {
  const m = signedManifest({});
  m.sig = 'not base64 at all !!!';
  throws(() => verifyManifest(m, [releasePub]), /does not match|not readable/i,
    'a malformed signature is a refusal, not an exception nobody handles');
});
