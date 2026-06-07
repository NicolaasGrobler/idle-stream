// Tests for the session-bundle archive layer. These exercise the hand-rolled
// store-only tar (header size codec incl. >8 GiB base-256, write -> extract
// round-trip with padding), the zip-slip / path-traversal guard on extract, and
// the untrusted-manifest validation. They use real temp files but never spawn
// ffmpeg/tar and never touch the project's data/ or recordings/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  tarHeader, readSize, writeBundleFile, extractBundle, safeClipDest, parseManifest,
} from '../bundle.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'wms-bundle-')); }

test('tar size field round-trips, including the >8 GiB base-256 path', () => {
  // 0o77777777777 (8 GiB - 1) is the largest size the octal field holds; above it
  // the writer switches to GNU base-256 and the reader must decode it.
  const sizes = [0, 1, 5, 511, 512, 513, 1000, 0o77777777777, 2 ** 33, 25 * 2 ** 30];
  for (const size of sizes) {
    const h = tarHeader('recordings/cam1/clip.mp4', size, 1_700_000_000);
    assert.equal(readSize(h), size, `size ${size}`);
  }
});

test('write -> extract round-trips file contents and the manifest', async () => {
  const dir = tmp();
  try {
    // Two source "clips" with non-block-aligned sizes to exercise 512-byte padding.
    const srcA = join(dir, 'a.bin'); writeFileSync(srcA, Buffer.alloc(1000, 0xab));
    const srcM = join(dir, 'm.bin'); writeFileSync(srcM, Buffer.alloc(5, 0xcd));
    const entries = [
      { name: 'recordings/cam1/clipA.mp4', filePath: srcA, size: statSync(srcA).size, mtimeSec: 1_700_000_000 },
      { name: 'recordings/mic1/clipM.mp4', filePath: srcM, size: statSync(srcM).size, mtimeSec: 1_700_000_001 },
    ];
    const manifest = {
      bundleFormatVersion: 1,
      app: 'wireless-multicam-studio',
      session: { sessionId: 'abcd1234', startedAt: 1000, stoppedAt: 1100, cameras: [{ id: 'cam1' }, { id: 'mic1' }] },
      clips: entries.map((e) => {
        const [, camId, name] = e.name.split('/');
        return { camId, name, sizeBytes: e.size, mtimeMs: e.mtimeSec * 1000 };
      }),
    };
    const tarPath = join(dir, 'bundle.tar');
    await writeBundleFile(tarPath, Buffer.from(JSON.stringify(manifest)), entries);

    const out = join(dir, 'out');
    const { manifest: m2, extracted } = extractBundle(tarPath, out);
    assert.equal(m2.session.sessionId, 'abcd1234');
    assert.equal(extracted.length, 2);
    assert.deepEqual(readFileSync(join(out, 'recordings', 'cam1', 'clipA.mp4')), readFileSync(srcA));
    assert.deepEqual(readFileSync(join(out, 'recordings', 'mic1', 'clipM.mp4')), readFileSync(srcM));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extract rejects a path-traversal entry (zip-slip) before writing it', async () => {
  const dir = tmp();
  try {
    const src = join(dir, 'x.bin'); writeFileSync(src, Buffer.alloc(16, 1));
    const manifest = { bundleFormatVersion: 1, session: { sessionId: 'evil', startedAt: 0, stoppedAt: 1, cameras: [] }, clips: [] };
    const tarPath = join(dir, 'evil.tar');
    // A hostile entry name that would escape the destination if extracted naively.
    await writeBundleFile(tarPath, Buffer.from(JSON.stringify(manifest)),
      [{ name: '../evil.txt', filePath: src, size: statSync(src).size, mtimeSec: 1_700_000_000 }]);
    assert.throws(() => extractBundle(tarPath, join(dir, 'out')), /unexpected entry|unsafe|escapes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('safeClipDest: accepts a normal clip path, rejects traversal/absolute/drive/UNC/shape', () => {
  const dest = tmp();
  try {
    assert.doesNotThrow(() => safeClipDest('recordings/cam1/2026-06-07_10-00-00-000000.mp4', dest));
    assert.doesNotThrow(() => safeClipDest('recordings/mic1/clip.mp4', dest));
    for (const bad of [
      '../evil.txt',                 // climbs out (wrong segment count)
      'recordings/../secret',        // '..' as a segment
      'recordings/cam1/../../x',     // too many segments + '..'
      '/etc/cron.d/x',               // absolute (POSIX) / drive-root (Windows)
      'C:/Windows/System32/x',       // drive letter
      '//server/share/x',            // UNC
      'evil/cam1/x.mp4',             // not under recordings/
      'recordings/cam 1/x.mp4',      // camId fails SAFE (space)
    ]) {
      assert.throws(() => safeClipDest(bad, dest), new RegExp('unexpected entry|unsafe|escapes'), `should reject: ${bad}`);
    }
  } finally { rmSync(dest, { recursive: true, force: true }); }
});

test('parseManifest: accepts a good manifest, rejects malformed/hostile ones', () => {
  const ok = {
    bundleFormatVersion: 1,
    session: { sessionId: 'a_b-1', startedAt: 1, stoppedAt: 2, cameras: [{ id: 'cam1' }] },
    clips: [{ camId: 'cam1', name: 'c.mp4', sizeBytes: 10, mtimeMs: 1000 }],
  };
  assert.equal(parseManifest(Buffer.from(JSON.stringify(ok))).session.sessionId, 'a_b-1');

  const bad = (obj, re) => assert.throws(() => parseManifest(Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))), re);
  bad('{not json', /valid JSON/);
  bad({ bundleFormatVersion: 99, session: {}, clips: [] }, /unsupported bundle version/);
  bad({ bundleFormatVersion: 1, session: { sessionId: 'bad id!', startedAt: 1, stoppedAt: 2, cameras: [] }, clips: [] }, /invalid id/);
  bad({ bundleFormatVersion: 1, session: { sessionId: 'ok', startedAt: 'x', stoppedAt: 2, cameras: [] }, clips: [] }, /invalid timestamps/);
  bad({ bundleFormatVersion: 1, session: { sessionId: 'ok', startedAt: 1, stoppedAt: 2, cameras: [{ id: '../x' }] }, clips: [] }, /invalid camera id/);
  bad({ bundleFormatVersion: 1, session: { sessionId: 'ok', startedAt: 1, stoppedAt: 2, cameras: [{ id: 'cam1' }] }, clips: [{ camId: 'cam1', name: '../x', sizeBytes: 1, mtimeMs: 1 }] }, /invalid clip name/);
});
