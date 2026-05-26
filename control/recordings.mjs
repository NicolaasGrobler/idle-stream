// Read-only access to the captured recordings on disk.
//
// MediaMTX writes copy-only fMP4 to recordings/<cam>/<timestamp>.mp4. This lists
// them for the dashboard and resolves a single file for download — by camera +
// filename only (validated, joined under the recordings root) so a caller can
// never traverse outside it.
import {
  readdirSync, statSync, statfsSync, mkdirSync, writeFileSync, unlinkSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORDINGS = join(ROOT, 'recordings');
const SAFE = /^[A-Za-z0-9._-]+$/;   // single path segment, no separators

function safeStat(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

export function listRecordings() {
  const cams = [];
  const rootStat = safeStat(RECORDINGS);
  if (!rootStat || !rootStat.isDirectory()) return cams;
  for (const camName of readdirSync(RECORDINGS).sort()) {
    const camDir = join(RECORDINGS, camName);
    const cs = safeStat(camDir);
    if (!cs || !cs.isDirectory()) continue;
    const files = [];
    for (const fname of readdirSync(camDir).sort()) {
      const fpath = join(camDir, fname);
      const st = safeStat(fpath);
      if (st && st.isFile()) {
        files.push({ name: fname, sizeBytes: st.size, modified: st.mtimeMs / 1000 });
      }
    }
    cams.push({
      cam: camName,
      files,
      totalBytes: files.reduce((sum, x) => sum + x.sizeBytes, 0),
    });
  }
  return cams;
}

// Disk-readiness for recording: is the recordings folder writable, and how much
// free space is there. (Codec/audio/live are checked client-side from the
// MediaMTX paths list.)
export function preflight() {
  mkdirSync(RECORDINGS, { recursive: true });
  let writable = false;
  const probe = join(RECORDINGS, `.preflight-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(probe, '');
    unlinkSync(probe);
    writable = true;
  } catch {
    writable = false;
  }
  let free = null;
  try {
    const fs = statfsSync(RECORDINGS);
    free = fs.bavail * fs.bsize;
  } catch {
    free = null;
  }
  return { recordingsWritable: writable, freeBytes: free, recordingsPath: RECORDINGS };
}

// Map (cam, name) to a file under the recordings root, or null if invalid.
export function resolveRecording(cam, name) {
  if (!(SAFE.test(cam || '') && SAFE.test(name || ''))) return null;
  if (cam === '..' || name === '..') return null;
  const root = resolve(RECORDINGS);
  const p = resolve(root, cam, name);
  const rel = relative(root, p);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;   // reject anything outside the root
  const st = safeStat(p);
  return st && st.isFile() ? p : null;
}
