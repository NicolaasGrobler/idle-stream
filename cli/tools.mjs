// Download the binary tools (mkcert, MediaMTX) for the current OS/arch into
// ./tools. Idempotent: skips anything already present. Cross-platform via the
// system `tar` (bsdtar on Windows 10+/macOS, GNU tar on Linux) for extraction.
import { existsSync, mkdirSync, rmSync, chmodSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { paths, target, isWin } from './platform.mjs';

const MEDIAMTX_VERSION = 'v1.18.2';
const MKCERT_VERSION = 'v1.4.4';

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

export async function fetchTools() {
  const { platform, arch } = target();
  mkdirSync(paths.tools, { recursive: true });

  // --- mkcert (single binary) ---
  if (existsSync(paths.mkcert)) {
    console.log('mkcert already present.');
  } else {
    const suffix = platform === 'windows' ? '.exe' : '';
    const url = `https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-${platform}-${arch}${suffix}`;
    console.log(`Downloading mkcert ${MKCERT_VERSION} (${platform}/${arch})...`);
    await download(url, paths.mkcert);
    if (!isWin) chmodSync(paths.mkcert, 0o755);
  }

  // --- MediaMTX (archive with the binary + a default config) ---
  if (existsSync(paths.mediamtx)) {
    console.log('MediaMTX already present.');
  } else {
    const ext = platform === 'windows' ? 'zip' : 'tar.gz';
    const url = `https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_${platform}_${arch}.${ext}`;
    const archive = join(paths.tools, `mediamtx.${ext}`);
    console.log(`Downloading MediaMTX ${MEDIAMTX_VERSION} (${platform}/${arch})...`);
    await download(url, archive);
    // `tar -xf` auto-detects zip (bsdtar) and gzip on every supported platform.
    execFileSync('tar', ['-xf', archive, '-C', paths.tools], { stdio: 'inherit' });
    rmSync(archive, { force: true });
    // We ship our own config; drop the bundled default so it can't be picked up.
    rmSync(join(paths.tools, 'mediamtx.yml'), { force: true });
    if (!isWin && existsSync(paths.mediamtx)) chmodSync(paths.mediamtx, 0o755);
  }

  console.log(`Tools ready in ${paths.tools}`);
  for (const f of readdirSync(paths.tools)) console.log(`  ${f}`);
}
