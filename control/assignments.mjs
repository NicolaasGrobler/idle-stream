// Persistence for phone slot assignments (data/assignments.json).
//
// Phones are identified by a stable id they carry in localStorage. Their camera
// assignment otherwise lives only in memory, so a control-service restart (or
// crash) mid-session would forget which phone is which camera — even though the
// phones keep streaming. Persisting {id: {name, slot}} lets a reconnecting phone
// be restored to its slot automatically.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = process.env.MULTICAM_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'data', 'assignments.json');

export function load() {
  try {
    const data = JSON.parse(readFileSync(STORE, 'utf-8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function save(map) {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(map, null, 2), 'utf-8');
}
