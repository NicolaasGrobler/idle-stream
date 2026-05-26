// Persistence for switch-log sessions (data/switches.json).
//
// Each completed recording session is appended as one object: when it started
// and stopped, each camera's record-start timestamp, and the ordered list of
// operator "takes" (which camera was the program feed and at what offset). The
// editor uses this in post to cut the final edit from the per-angle recordings.
//
// Offsets are seconds from the session start, so they map directly onto the
// recording timeline. Absolute epochs are kept as the authoritative anchor.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'data', 'switches.json');

export function loadSessions() {
  try {
    const data = JSON.parse(readFileSync(STORE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function appendSession(session) {
  mkdirSync(dirname(STORE), { recursive: true });
  let data;
  try {
    data = JSON.parse(readFileSync(STORE, 'utf-8'));
    if (!Array.isArray(data)) data = [];
  } catch {
    data = [];
  }
  data.push(session);
  writeFileSync(STORE, JSON.stringify(data, null, 2), 'utf-8');
}

// Remove one session by id. Returns true if a session was removed. The
// recorded clip files are not touched (delete those via the recordings API).
export function deleteSession(sessionId) {
  const sessions = loadSessions();
  const next = sessions.filter((s) => s.sessionId !== sessionId);
  if (next.length === sessions.length) return false;
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(next, null, 2), 'utf-8');
  return true;
}
