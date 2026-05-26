// Cross-platform paths and helpers shared by the CLI subcommands.
import os from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const isWin = process.platform === 'win32';
const exe = isWin ? '.exe' : '';

export const paths = {
  root: ROOT,
  tools: join(ROOT, 'tools'),
  certs: join(ROOT, 'certs'),
  logs: join(ROOT, 'logs'),
  mkcert: join(ROOT, 'tools', `mkcert${exe}`),
  mediamtx: join(ROOT, 'tools', `mediamtx${exe}`),
  mediamtxConfig: join(ROOT, 'mediamtx', 'mediamtx.yml'),
  mediamtxConfigGen: join(ROOT, 'mediamtx', 'mediamtx.gen.yml'),
  certIpFile: join(ROOT, 'certs', '.lan-ip'),
};

// Map Node's process.arch / platform to the release-asset vocabulary used by
// the mkcert and MediaMTX GitHub releases.
export function target() {
  const archMap = { x64: 'amd64', arm64: 'arm64', arm: 'arm' };
  const osMap = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
  const arch = archMap[process.arch];
  const platform = osMap[process.platform];
  if (!arch || !platform) {
    throw new Error(`Unsupported platform/arch: ${process.platform}/${process.arch}`);
  }
  return { platform, arch };
}

// Detect the machine's LAN IPv4. Skips loopback, virtual, and VPN adapters;
// prefers 192.168.x, then 10.x, then 172.16–31.x. `pref` (e.g. --ip) wins.
export function getLanIP(pref) {
  if (pref) return pref;
  const skip = /^(lo|lo0|vethernet|loopback|wsl|tailscale|zerotier|virtualbox|vmware|vboxnet|docker|veth|utun|tun|tap|awdl|llw|bridge)/i;
  const isPrivate = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(ip);
  const cands = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (isPrivate(a.address)) cands.push(a.address);
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  cands.sort((x, y) => rank(x) - rank(y));
  if (cands.length === 0) throw new Error('Could not auto-detect a LAN IP. Re-run with --ip <addr>.');
  if (cands.length > 1) {
    console.warn(`Multiple LAN IPs found: ${cands.join(', ')}.`);
    console.warn(`Using ${cands[0]}. Re-run with --ip <addr> to pick another.`);
  }
  return cands[0];
}

// Render the network-agnostic mediamtx.yml into mediamtx.gen.yml with the
// detected LAN IP injected as an explicit WebRTC host.
export function renderMediamtxConfig(ip) {
  const src = readFileSync(paths.mediamtxConfig, 'utf8');
  const out = src.replace(/^webrtcAdditionalHosts:.*$/m, `webrtcAdditionalHosts: [${ip}]`);
  writeFileSync(paths.mediamtxConfigGen, out);
}

// Parse `--ip <addr>` / `--ip=<addr>` out of argv; returns the value or null.
export function parseIpFlag(argv) {
  const i = argv.indexOf('--ip');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--ip='));
  return eq ? eq.slice('--ip='.length) : null;
}
