import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const helpers = fs.readFileSync('functions/_shared/helpers.ts', 'utf8');

test('Cloudflare PBKDF2 runtime cap is enforced for hash and verify paths', () => {
  assert.match(helpers, /PBKDF2_MAX_RUNTIME_ITERATIONS = 100_000/);
  assert.match(helpers, /PBKDF2_ITERATIONS = PBKDF2_MAX_RUNTIME_ITERATIONS/);
  assert.match(helpers, /iterations > PBKDF2_MAX_RUNTIME_ITERATIONS/);
  assert.doesNotMatch(helpers, /PBKDF2_ITERATIONS = 210_000/);
});

test('legacy hashes can still be upgraded toward the current runtime-safe target', () => {
  assert.match(helpers, /needsPasswordRehash/);
  assert.match(helpers, /n !== PBKDF2_ITERATIONS/);
  assert.match(helpers, /stored\.includes\(':'\)/);
});
