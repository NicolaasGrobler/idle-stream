// Portable session bundles: export ONE recording session — its switch-log entry
// plus every per-camera/mic clip it references — to a single archive, and import
// that archive on another (faster) machine to do the slow preview/export there.
//
// WHY this shape:
//  - The clips are already H.264/Opus (copy-only fMP4). Compressing them wastes CPU
//    on the source machine (the slow laptop this feature exists for) for ~0% gain,
//    so the bundle is a STORE-ONLY tar — bytes verbatim, just framed.
//  - The whole editorial timeline is anchored to FILE MTIME: exports.mjs matches a
//    session's clips by an mtime window and positions each segment at
//    (mtime - duration - sessionStart), and the dashboard preview filters by the
//    same window. So the bundle records each clip's exact mtime in a manifest and
//    the importer RESTORES it (utimes) — keeping the unchanged export/preview code
//    correct on the target. (A naive zip/Explorer copy resets mtimes to "now",
//    which silently makes a session export as all-black; this is the trap we avoid.)
//  - We pack/unpack the tar IN-PROCESS rather than shelling to `tar`: it lets us
//    stream the archive straight to the HTTP response (no doubling the session's
//    footprint on disk), embed the in-memory manifest, and — most importantly —
//    validate every entry name before writing a single byte (no zip-slip / path
//    traversal). Store-only tar with large-file (>8 GiB) sizes is small and testable.
import {
  statSync, statfsSync, createReadStream, createWriteStream, readFileSync,
  mkdirSync, rmSync, renameSync, existsSync, utimesSync,
  openSync, readSync, writeSync, closeSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';

import { listRecordings, resolveRecording } from './recordings.mjs';
import { filesForCam } from './exports.mjs';
import { loadSessions, appendSession, deleteSession } from './switches.mjs';

const ROOT = process.env.MULTICAM_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORDINGS = join(ROOT, 'recordings');
const EXPORTS = join(ROOT, 'exports');
const BUNDLES = join(ROOT, 'bundles');

const SAFE = /^[A-Za-z0-9._-]+$/;     // single path segment (mirrors recordings.mjs)
const SAFE_ID = /^[A-Za-z0-9_-]+$/;   // session id (mirrors exports.mjs)
const BLOCK = 512;
const FORMAT_VERSION = 1;
const OCTAL_SIZE_MAX = 0o77777777777; // 8 GiB - 1; above this, tar uses base-256

const randId = () => randomBytes(6).toString('hex');
const nowSec = () => Math.floor(Date.now() / 1000);

function appVersion() {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version || null; }
  catch { return null; }
}

// ----- tar header encode -----------------------------------------------------

function writeStr(buf, s, off, len) {
  const b = Buffer.from(s, 'utf-8');
  if (b.length > len) throw new Error(`tar field too long (${b.length}>${len}): ${s}`);
  b.copy(buf, off);
}
// width includes a trailing NUL: (width-1) zero-padded octal digits, then NUL.
function writeOctal(buf, n, off, width) {
  const s = Math.floor(n).toString(8).padStart(width - 1, '0');
  if (s.length > width - 1) throw new Error(`octal overflow for ${n}`);
  buf.write(s, off, width - 1, 'ascii');
  buf[off + width - 1] = 0;
}
// 12-byte size field: octal when it fits, else GNU base-256 (high bit of byte 0).
function writeSize(buf, size, off) {
  if (size <= OCTAL_SIZE_MAX) { writeOctal(buf, size, off, 12); return; }
  buf[off] = 0x80;
  let v = BigInt(size);
  for (let i = off + 11; i > off; i--) { buf[i] = Number(v & 0xffn); v >>= 8n; }
}
// checksum field: 6 octal digits, NUL, space.
function writeChecksum(buf, sum, off) {
  buf.write(sum.toString(8).padStart(6, '0'), off, 6, 'ascii');
  buf[off + 6] = 0;
  buf[off + 7] = 0x20;
}
export function tarHeader(name, size, mtimeSec) {
  const buf = Buffer.alloc(BLOCK);
  writeStr(buf, name, 0, 100);
  writeOctal(buf, 0o644, 100, 8);   // mode
  writeOctal(buf, 0, 108, 8);       // uid
  writeOctal(buf, 0, 116, 8);       // gid
  writeSize(buf, size, 124);        // size
  writeOctal(buf, mtimeSec, 136, 12);
  buf.fill(0x20, 148, 156);         // checksum placeholder = 8 spaces
  buf[156] = 0x30;                  // typeflag '0' = regular file
  writeStr(buf, 'ustar', 257, 6);
  buf[263] = 0x30; buf[264] = 0x30; // version "00"
  let sum = 0; for (let i = 0; i < BLOCK; i++) sum += buf[i];
  writeChecksum(buf, sum, 148);
  return buf;
}

// ----- tar header decode -----------------------------------------------------

function readField(b, off, len) {
  let end = off;
  while (end < off + len && b[end] !== 0) end++;
  return b.toString('utf-8', off, end);
}
export function readSize(header, off = 124) {
  if (header[off] & 0x80) {                       // base-256
    let v = 0n;
    for (let i = off + 1; i < off + 12; i++) v = (v << 8n) | BigInt(header[i]);
    return Number(v);
  }
  return parseInt(readField(header, off, 12).trim() || '0', 8) || 0;
}
function isZeroBlock(b) { for (let i = 0; i < BLOCK; i++) if (b[i] !== 0) return false; return true; }
function checksumOk(header) {
  const stored = parseInt(readField(header, 148, 8).trim(), 8);
  if (!Number.isFinite(stored)) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 0x20 : header[i];
  return sum === stored;
}

// ----- streaming writer (to an HTTP response or a file) ----------------------

const padLen = (size) => (BLOCK - (size % BLOCK)) % BLOCK;
export const entryBytes = (size) => BLOCK + size + padLen(size);

function writeChunk(out, buf) {
  return new Promise((res, rej) => out.write(buf, (err) => (err ? rej(err) : res())));
}
async function writeMemEntry(out, name, body) {
  await writeChunk(out, tarHeader(name, body.length, nowSec()));
  await writeChunk(out, body);
  if (padLen(body.length)) await writeChunk(out, Buffer.alloc(padLen(body.length)));
}
async function writeFileEntry(out, name, filePath, size, mtimeSec) {
  const st = statSync(filePath);
  if (st.size !== size) throw new Error(`clip changed during bundling: ${filePath}`);
  await writeChunk(out, tarHeader(name, size, mtimeSec));
  await new Promise((res, rej) => {
    const rs = createReadStream(filePath);
    rs.on('error', rej);
    rs.on('end', res);
    rs.pipe(out, { end: false });
  });
  if (padLen(size)) await writeChunk(out, Buffer.alloc(padLen(size)));
}
async function writeBundle(out, manifestBuf, entries) {
  await writeMemEntry(out, 'manifest.json', manifestBuf);
  for (const e of entries) await writeFileEntry(out, e.name, e.filePath, e.size, e.mtimeSec);
  await writeChunk(out, Buffer.alloc(BLOCK * 2));   // two zero blocks = end of archive
}

// Write a complete bundle to a file. `entries` = [{name, filePath, size, mtimeSec}].
export async function writeBundleFile(outPath, manifestBuf, entries) {
  const out = createWriteStream(outPath);
  await writeBundle(out, manifestBuf, entries);
  await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));
}

// ----- planning / manifest ---------------------------------------------------

// Resolve a session and every clip the exporter would look for. Drives file
// collection from session.cameras + filesForCam (the SAME matcher export/preview
// use) so the bundle contains exactly what they'll resolve — every camera AND mic,
// including reconnect splits — never a guessed subset.
export function planBundle(sessionId) {
  const session = loadSessions().find((s) => s.sessionId === sessionId);
  if (!session) return null;
  const recCams = listRecordings();
  const clips = [];
  for (const cam of (session.cameras || [])) {
    for (const f of filesForCam(recCams, cam.id, session)) {
      const filePath = resolveRecording(cam.id, f.name);   // re-validates SAFE + traversal
      if (!filePath) continue;
      const st = statSync(filePath);
      clips.push({ camId: cam.id, name: f.name, sizeBytes: st.size, mtimeMs: st.mtimeMs, filePath });
    }
  }
  return { session, clips };
}

function manifestJson(session, clips) {
  return Buffer.from(JSON.stringify({
    bundleFormatVersion: FORMAT_VERSION,
    app: 'wireless-multicam-studio',
    appVersion: appVersion(),
    createdAtMs: Date.now(),
    session,
    clips: clips.map((c) => ({ camId: c.camId, name: c.name, sizeBytes: c.sizeBytes, mtimeMs: c.mtimeMs })),
  }, null, 2));
}

function bundleFilename(session) {
  const base = String(session.name || session.sessionId || 'session')
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'session';
  return `${base}.studiobundle.tar`;
}

function entriesFor(clips) {
  return clips.map((c) => ({
    name: `recordings/${c.camId}/${c.name}`,
    filePath: c.filePath,
    size: c.sizeBytes,
    mtimeSec: Math.floor(c.mtimeMs / 1000),
  }));
}

// ----- HTTP download ---------------------------------------------------------

// Stream a session's bundle as a download. Length is known up front (store-only),
// so we send Content-Length (progress bar) rather than chunked. Returns false if
// the session doesn't exist (caller 404s).
export function serveBundle(sessionId, req, res) {
  if (!SAFE_ID.test(sessionId || '')) return false;
  const plan = planBundle(sessionId);
  if (!plan) return false;
  const manifestBuf = manifestJson(plan.session, plan.clips);
  const entries = entriesFor(plan.clips);
  let total = entryBytes(manifestBuf.length) + BLOCK * 2;
  for (const e of entries) total += entryBytes(e.size);
  res.writeHead(200, {
    'content-type': 'application/x-tar',
    'content-disposition': `attachment; filename="${bundleFilename(plan.session)}"`,
    'content-length': total,
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  writeBundle(res, manifestBuf, entries)
    .then(() => res.end())
    .catch(() => { try { res.destroy(); } catch { /* already gone */ } });
  return true;
}

// ----- CLI: write a bundle to a file -----------------------------------------

export async function bundleToFile(sessionId, outPath) {
  const plan = planBundle(sessionId);
  if (!plan) throw new Error(`session not found: ${sessionId}`);
  const entries = entriesFor(plan.clips);
  await writeBundleFile(outPath, manifestJson(plan.session, plan.clips), entries);
  return { outPath, clips: entries.length, sessionId: plan.session.sessionId };
}

// Write a session's bundle straight to a folder ON THIS MACHINE and return the
// path — the operator dashboard and the control service run on the same laptop,
// so there's no reason to round-trip a multi-GB archive out through a browser
// download to land it on the same disk. Defaults to the app's bundles/ folder
// (created on demand); the dir is auto-named after the session, like serveBundle.
export async function saveBundle(sessionId, dir) {
  const plan = planBundle(sessionId);
  if (!plan) throw new Error(`session not found: ${sessionId}`);
  const outDir = dir || BUNDLES;
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, bundleFilename(plan.session));
  const entries = entriesFor(plan.clips);
  await writeBundleFile(outPath, manifestJson(plan.session, plan.clips), entries);
  return { outPath, clips: entries.length, sessionId: plan.session.sessionId };
}

// ----- tar reader / safe extract ---------------------------------------------

function readFull(fd, buf, len) {
  let off = 0;
  while (off < len) {
    const n = readSync(fd, buf, off, len - off, null);
    if (n <= 0) break;
    off += n;
  }
  return off;
}
function skip(fd, n) { if (n > 0) readFull(fd, Buffer.alloc(n), n); }
function collect(fd, size) {
  const buf = Buffer.alloc(size);
  if (readFull(fd, buf, size) < size) throw new Error('corrupt bundle (truncated entry)');
  skip(fd, padLen(size));
  return buf;
}
function copyToFile(fd, size, destPath) {
  const wfd = openSync(destPath, 'w');
  try {
    let remaining = size;
    const chunk = Buffer.alloc(1 << 20);   // 1 MiB
    while (remaining > 0) {
      const want = Math.min(remaining, chunk.length);
      const got = readSync(fd, chunk, 0, want, null);
      if (got <= 0) throw new Error('corrupt bundle (truncated file body)');
      writeSync(wfd, chunk, 0, got);
      remaining -= got;
    }
  } finally { closeSync(wfd); }
  skip(fd, padLen(size));
}

// Map an archive entry name to a safe destination under destDir. Accepts ONLY
// `recordings/<safe-camId>/<safe-name>`; rejects absolute, drive-letter, UNC,
// '..' and anything that would escape destDir. Defends against zip-slip even
// though we never hand the name to an external extractor.
export function safeClipDest(name, destDir) {
  const norm = String(name).replace(/\\/g, '/');
  if (isAbsolute(norm) || /^[A-Za-z]:/.test(norm) || norm.startsWith('//')) {
    throw new Error(`unsafe entry path: ${name}`);
  }
  const parts = norm.split('/');
  if (parts.length !== 3 || parts[0] !== 'recordings') throw new Error(`unexpected entry: ${name}`);
  const [, camId, file] = parts;
  if (!SAFE.test(camId) || camId === '..' || !SAFE.test(file) || file === '..') {
    throw new Error(`unsafe entry name: ${name}`);
  }
  const dest = resolve(destDir, 'recordings', camId, file);
  const rel = relative(resolve(destDir), dest);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`entry escapes destination: ${name}`);
  return dest;
}

// Read manifest.json (must be the first entry) without extracting the rest.
function peekManifest(tarPath) {
  const fd = openSync(tarPath, 'r');
  try {
    const header = Buffer.alloc(BLOCK);
    if (readFull(fd, header, BLOCK) < BLOCK || isZeroBlock(header)) throw new Error('empty or invalid bundle');
    if (!checksumOk(header)) throw new Error('not a studio bundle (bad header)');
    if (readField(header, 0, 100) !== 'manifest.json') throw new Error('not a studio bundle (manifest.json must come first)');
    return parseManifest(collect(fd, readSize(header)));
  } finally { closeSync(fd); }
}

// Extract every entry into destDir (clips validated through safeClipDest), and
// return the manifest plus the list of extracted clip paths.
export function extractBundle(tarPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const fd = openSync(tarPath, 'r');
  let manifestBuf = null;
  const extracted = [];
  try {
    const header = Buffer.alloc(BLOCK);
    for (;;) {
      if (readFull(fd, header, BLOCK) < BLOCK || isZeroBlock(header)) break;
      if (!checksumOk(header)) throw new Error('corrupt bundle (bad header checksum)');
      const name = readField(header, 0, 100);
      const type = header[156];
      const size = readSize(header);
      if (type !== 0x30 && type !== 0x00) {   // regular files only — no symlinks/devices/etc.
        throw new Error(`unsupported entry type in bundle: ${name}`);
      }
      if (name === 'manifest.json') { manifestBuf = collect(fd, size); continue; }
      const dest = safeClipDest(name, destDir);
      mkdirSync(dirname(dest), { recursive: true });
      copyToFile(fd, size, dest);
      extracted.push({ name, size });
    }
  } finally { closeSync(fd); }
  if (!manifestBuf) throw new Error('bundle has no manifest.json');
  return { manifest: parseManifest(manifestBuf), extracted };
}

// ----- manifest validation (treat as untrusted input) ------------------------

export function parseManifest(buf) {
  let m;
  try { m = JSON.parse(buf.toString('utf-8')); }
  catch { throw new Error('bundle manifest is not valid JSON'); }
  if (!m || typeof m !== 'object') throw new Error('bad bundle manifest');
  if (m.bundleFormatVersion !== FORMAT_VERSION) {
    throw new Error(`unsupported bundle version (${m.bundleFormatVersion}); this app understands v${FORMAT_VERSION}`);
  }
  const s = m.session;
  if (!s || typeof s !== 'object') throw new Error('bundle manifest has no session');
  if (!SAFE_ID.test(s.sessionId || '')) throw new Error('bundle session has an invalid id');
  if (!Number.isFinite(s.startedAt) || !Number.isFinite(s.stoppedAt)) throw new Error('bundle session has invalid timestamps');
  if (!Array.isArray(s.cameras)) throw new Error('bundle session has no cameras');
  for (const c of s.cameras) {
    if (!c || !SAFE.test(c.id || '') || c.id === '..') throw new Error(`bundle has an invalid camera id: ${c && c.id}`);
  }
  if (!Array.isArray(m.clips)) throw new Error('bundle manifest has no clips list');
  for (const c of m.clips) {
    if (!c || !SAFE.test(c.camId || '') || c.camId === '..') throw new Error(`bundle has an invalid clip camId: ${c && c.camId}`);
    if (!SAFE.test(c.name || '') || c.name === '..') throw new Error(`bundle has an invalid clip name: ${c && c.name}`);
    if (!Number.isFinite(c.sizeBytes) || c.sizeBytes < 0) throw new Error('bundle clip has an invalid size');
    if (!Number.isFinite(c.mtimeMs)) throw new Error('bundle clip has an invalid mtime');
  }
  return m;
}

// ----- import ----------------------------------------------------------------

function ensureFreeSpace(manifest) {
  let need = 0;
  for (const c of manifest.clips) need += c.sizeBytes || 0;
  let free;
  try { const fs = statfsSync(RECORDINGS); free = fs.bavail * fs.bsize; }
  catch { return; }   // can't probe — let extraction surface any ENOSPC itself
  if (free < need * 1.05) {
    const gib = (n) => (n / 2 ** 30).toFixed(1);
    throw new Error(`not enough disk space to import: need ~${gib(need)} GiB, ${gib(free)} GiB free`);
  }
}

function clearStaleExport(sessionId) {
  // A re-imported session shouldn't serve a previously-rendered MP4; drop it so
  // the next export re-renders. (The export job's `ready` is gated on the file
  // existing, so removing it is enough.)
  try { rmSync(join(EXPORTS, `${sessionId}.mp4`), { force: true }); } catch { /* ignore */ }
}

// Import a bundle file already on disk. mode:
//   'skip'    (default) refuse if the sessionId already exists
//   'replace' overwrite the existing session entry (and its stale rendered MP4)
//   'copy'    import under a fresh sessionId (keeps the original too)
// Transactional: extracts into a staging dir under recordings/, verifies against
// the manifest, then moves clips into place and appends the session LAST. On any
// failure the staging dir is removed and switches.json is untouched.
export function importBundleFromFile(tarPath, opts = {}) {
  if (!existsSync(tarPath)) throw new Error(`no such bundle file: ${tarPath}`);
  const mode = ['skip', 'replace', 'copy'].includes(opts.mode) ? opts.mode : 'skip';
  ensureFreeSpace(peekManifest(tarPath));

  const staging = join(RECORDINGS, `.import-${randId()}`);
  try {
    const { manifest, extracted } = extractBundle(tarPath, staging);
    let session = manifest.session;

    const existing = loadSessions().some((s) => s.sessionId === session.sessionId);
    if (existing && mode === 'skip') return { ok: false, conflict: true, sessionId: session.sessionId };
    if (existing && mode === 'copy') {
      session = { ...session, sessionId: randId(), name: `${session.name || session.sessionId} (imported copy)` };
    }

    // Every manifest clip must be present with the expected size.
    const got = new Map(extracted.map((e) => [e.name, e.size]));
    for (const c of manifest.clips) {
      const key = `recordings/${c.camId}/${c.name}`;
      if (!got.has(key)) throw new Error(`bundle is missing clip ${key}`);
      if (got.get(key) !== c.sizeBytes) throw new Error(`size mismatch for ${key} (corrupt bundle)`);
    }

    // Move clips into place (staging is on the recordings volume, so rename is
    // atomic) and restore each mtime so the mtime-keyed matcher/placement works.
    let placed = 0;
    for (const c of manifest.clips) {
      const src = join(staging, 'recordings', c.camId, c.name);
      const destDir = join(RECORDINGS, c.camId);
      const dest = join(destDir, c.name);
      mkdirSync(destDir, { recursive: true });
      if (existsSync(dest)) continue;   // same timestamped clip already here — leave it
      renameSync(src, dest);
      const sec = c.mtimeMs / 1000;
      utimesSync(dest, sec, sec);
      placed++;
    }

    if (existing && mode === 'replace') { deleteSession(session.sessionId); clearStaleExport(session.sessionId); }
    appendSession(session);

    return {
      ok: true,
      sessionId: session.sessionId,
      cameras: (session.cameras || []).length,
      clips: manifest.clips.length,
      placed,
      mode: existing ? mode : 'new',
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// A temp path (on the ROOT volume) for streaming an HTTP upload before import.
export function tempUploadPath() {
  mkdirSync(EXPORTS, { recursive: true });
  return join(EXPORTS, `.upload-${randId()}.tar`);
}
