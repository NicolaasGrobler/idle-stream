// Persistence for the camera list (data/cameras.json).
//
// Seeded with three sensible defaults on first run so a fresh setup still works.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeCamera } from './state.mjs';

const ROOT = process.env.MULTICAM_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'data', 'cameras.json');
const DEFAULTS = [
  { id: 'cam1', label: 'Wide' },
  { id: 'cam2', label: 'Center' },
  { id: 'cam3', label: 'Side' },
];

export function load() {
  try {
    const raw = JSON.parse(readFileSync(STORE, 'utf-8'));
    const cams = raw.filter((c) => c && c.id).map((c) => makeCamera(c.id, c.label));
    if (cams.length) return cams;
  } catch {
    /* missing or malformed — fall through to defaults */
  }
  const cams = DEFAULTS.map((c) => makeCamera(c.id, c.label));
  save(cams);
  return cams;
}

export function save(cameras) {
  mkdirSync(dirname(STORE), { recursive: true });
  const data = cameras.map((c) => ({ id: c.id, label: c.label }));
  writeFileSync(STORE, JSON.stringify(data, null, 2), 'utf-8');
}
