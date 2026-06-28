/**
 * Lightweight unit tests for the pure, security-critical logic (no DB / DI needed).
 * Run: pnpm --filter @neurion/api test:unit   (tsx scripts/unit-test.ts)
 */
import 'reflect-metadata';
import assert from 'node:assert';
import { PrivacyClassifierService } from '../src/ai/privacy/classifier.service';
import { maxPrivacy, allowedTrustLevels, CHAT_PRIVACY_FLOOR } from '../src/ai/privacy/privacy.util';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(e as Error).message}`);
  }
}

// ---- G2 privacy classifier (advisory, fail-safe-UP, can only raise the floor) ----
const clf = new PrivacyClassifierService();

test('plain text is not escalated', () => {
  const r = clf.classify('what is the capital of France?');
  assert.equal(r.category, 'NONE');
  assert.equal(r.escalateTo, 'PUBLIC');
  assert.equal(r.hardTrustedOnly, false);
});

test('email + phone flag PII and escalate to VERIFIED_ONLY', () => {
  const r = clf.classify('contact me at mario.rossi@example.com or +39 333 1234567');
  assert.ok(r.flags.includes('PII'));
  assert.equal(r.escalateTo, 'VERIFIED_ONLY');
});

test('an API-key-like secret is SENSITIVE + hard trusted-only', () => {
  const r = clf.classify('here is my key sk-abcdefghijklmnopqrstuvwxyz0123');
  assert.ok(r.flags.includes('SECRET'));
  assert.equal(r.hardTrustedOnly, true);
  assert.equal(r.category, 'SENSITIVE');
  assert.equal(r.escalateTo, 'VERIFIED_ONLY');
});

test('a private key block is SENSITIVE', () => {
  const r = clf.classify('-----BEGIN RSA PRIVATE KEY-----\nMIIE...');
  assert.ok(r.flags.includes('SECRET'));
  assert.equal(r.hardTrustedOnly, true);
});

test('Article 9 health/financial terms escalate + hard trusted-only', () => {
  const r = clf.classify('the patient was diagnosed with cancer last year');
  assert.ok(r.flags.includes('ART9'));
  assert.equal(r.hardTrustedOnly, true);
  assert.equal(r.escalateTo, 'VERIFIED_ONLY');
});

test('classifier never throws — empty input is NONE', () => {
  const r = clf.classify('');
  assert.equal(r.category, 'NONE');
  assert.equal(r.failedSafe, false);
});

// ---- privacy.util ordering + trust gating ----
test('maxPrivacy returns the stricter level', () => {
  assert.equal(maxPrivacy('PUBLIC', 'VERIFIED_ONLY'), 'VERIFIED_ONLY');
  assert.equal(maxPrivacy('VERIFIED_ONLY', 'PUBLIC'), 'VERIFIED_ONLY');
  assert.equal(maxPrivacy('PUBLIC', 'PUBLIC'), 'PUBLIC');
});

test('CHAT_PRIVACY_FLOOR is VERIFIED_ONLY (default chat floor)', () => {
  assert.equal(CHAT_PRIVACY_FLOOR, 'VERIFIED_ONLY');
});

test('invariant: COMMUNITY allowed <=> effective is PUBLIC', () => {
  assert.ok(allowedTrustLevels('PUBLIC').has('COMMUNITY'));
  assert.ok(!allowedTrustLevels('VERIFIED_ONLY').has('COMMUNITY'));
  // VERIFIED_ONLY still permits VERIFIED+ nodes
  assert.ok(allowedTrustLevels('VERIFIED_ONLY').has('VERIFIED'));
  assert.ok(allowedTrustLevels('VERIFIED_ONLY').has('INTERNAL'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
