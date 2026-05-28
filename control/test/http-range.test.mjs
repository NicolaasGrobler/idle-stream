// Pure-function tests for the Range header parser shared by the recordings
// and exports endpoints. Locks in the three forms (open-start, open-end,
// suffix) and the 416 boundary so a regression on either consumer is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRange } from '../http-range.mjs';

test('parseRange: missing header -> null', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('', 1000), null);
});

test('parseRange: malformed header -> null', () => {
  assert.equal(parseRange('items=0-9', 1000), null);
  assert.equal(parseRange('bytes=foo-bar', 1000), null);
  assert.equal(parseRange('bytes=-', 1000), null);
});

test('parseRange: bytes=A-B inclusive', () => {
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
});

test('parseRange: bytes=A- (open end) clamps to total-1', () => {
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
});

test('parseRange: bytes=A-B with B >= total clamps to total-1', () => {
  assert.deepEqual(parseRange('bytes=900-9999', 1000), { start: 900, end: 999 });
});

test('parseRange: bytes=-N suffix returns last N bytes', () => {
  // The bug this helper was extracted to fix: end must be total-1, not N.
  assert.deepEqual(parseRange('bytes=-500', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
});

test('parseRange: suffix larger than total clamps start to 0', () => {
  assert.deepEqual(parseRange('bytes=-9999', 1000), { start: 0, end: 999 });
});

test('parseRange: unsatisfiable range -> 416', () => {
  assert.deepEqual(parseRange('bytes=2000-3000', 1000), { error: 416 });
  assert.deepEqual(parseRange('bytes=1000-', 1000), { error: 416 });   // start == total
});
