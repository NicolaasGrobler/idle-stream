// Persistence for operator-tunable settings (data/settings.json).
//
// Currently just the global publish bitrate (the default target for every
// camera; a camera can override it — see cameras.json). Kept separate from the
// camera list so a fresh setup gets a sensible default without touching cameras.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = process.env.MULTICAM_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'data', 'settings.json');

// Target publish bitrate at 1080p30. Recording is copy-only, so this is the
// recording quality. 8 Mbps is a solid default; the operator can push higher
// (10–12M) where the AP has headroom, or lower it on a congested network.
export const DEFAULT_BITRATE = 8_000_000;
const MIN_BITRATE = 1_000_000;
const MAX_BITRATE = 20_000_000;

// Coerce an arbitrary value to a valid bitrate, or null if it isn't one.
export function clampBitrate(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, n)));
}

export function load() {
  try {
    const raw = JSON.parse(readFileSync(STORE, 'utf-8'));
    return { globalBitrate: clampBitrate(raw.globalBitrate) ?? DEFAULT_BITRATE };
  } catch {
    return { globalBitrate: DEFAULT_BITRATE };
  }
}

export function save(settings) {
  mkdirSync(dirname(STORE), { recursive: true });
  const data = { globalBitrate: clampBitrate(settings.globalBitrate) ?? DEFAULT_BITRATE };
  writeFileSync(STORE, JSON.stringify(data, null, 2), 'utf-8');
}
