// Download the binary tools (mkcert, MediaMTX) for the current OS/arch into
// ./tools. Idempotent: skips anything already present. Cross-platform via the
// system `tar` (bsdtar on Windows 10+/macOS, GNU tar on Linux) for extraction.
import { existsSync, mkdirSync, rmSync, chmodSync, writeFileSync, readdirSync, statSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { paths, target, isWin } from './platform.mjs';

// The tar to extract with. On Windows pin to the system bsdtar (libarchive):
// it handles zip + gzip + xz, whereas a `tar` from Git Bash / MSYS is GNU tar,
// which can't read zip and mangles `C:\` paths. Elsewhere the system tar is fine.
function tarBin() {
  if (isWin) {
    const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (existsSync(sys)) return sys;
  }
  return 'tar';
}

// Extract an archive (in tools/) into tools/<destName>. Args are RELATIVE to
// cwd=tools/ so no argument carries a `C:` drive prefix. `tar -xf` auto-detects
// zip (bsdtar), gzip, and xz.
function extract(archiveName, destName) {
  mkdirSync(join(paths.tools, destName), { recursive: true });
  execFileSync(tarBin(), ['-xf', archiveName, '-C', destName], { cwd: paths.tools, stdio: 'inherit' });
}

const MEDIAMTX_VERSION = 'v1.18.2';
const MKCERT_VERSION = 'v1.4.4';

// ffmpeg static builds for the export feature. There's no single source that
// covers every OS/arch (unlike mkcert/MediaMTX), so this picks per platform:
//   Windows/Linux -> BtbN's rolling static GPL builds (ffmpeg + ffprobe bundled)
//   macOS         -> evermeet.cx (Intel; runs under Rosetta 2 on Apple Silicon)
// The Windows/Linux assets nest the binaries under <archive>/bin/; macOS ships
// each binary as its own zip. fetchFfmpeg extracts into a temp dir, locates the
// binaries by name anywhere in the tree, and moves them into ./tools.
function ffmpegSources(platform, arch) {
  if (platform === 'windows') {
    return [{ url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', ext: 'zip', bins: ['ffmpeg.exe', 'ffprobe.exe'] }];
  }
  if (platform === 'linux') {
    const a = arch === 'arm64' ? 'linuxarm64' : 'linux64';
    return [{ url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${a}-gpl.tar.xz`, ext: 'tar.xz', bins: ['ffmpeg', 'ffprobe'] }];
  }
  // macOS: evermeet ships ffmpeg and ffprobe as separate zips (Intel binaries).
  return [
    { url: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip', ext: 'zip', bins: ['ffmpeg'] },
    { url: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip', ext: 'zip', bins: ['ffprobe'] },
  ];
}

// Recursively find a file named `name` under `dir`.
function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
    else if (e.name === name) return p;
  }
  return null;
}

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
    extract(`mediamtx.${ext}`, '.');
    rmSync(archive, { force: true });
    // We ship our own config; drop the bundled default so it can't be picked up.
    rmSync(join(paths.tools, 'mediamtx.yml'), { force: true });
    if (!isWin && existsSync(paths.mediamtx)) chmodSync(paths.mediamtx, 0o755);
  }

  // --- ffmpeg + ffprobe (static build; used by the session export) ---
  if (existsSync(paths.ffmpeg) && existsSync(paths.ffprobe)) {
    console.log('ffmpeg already present.');
  } else {
    for (const src of ffmpegSources(platform, arch)) {
      const archive = join(paths.tools, `ffmpeg-dl.${src.ext}`);
      const tmp = join(paths.tools, 'ffmpeg-extract');
      console.log(`Downloading ffmpeg (${platform}/${arch}) from ${new URL(src.url).host}...`);
      await download(src.url, archive);
      rmSync(tmp, { recursive: true, force: true });
      extract(`ffmpeg-dl.${src.ext}`, 'ffmpeg-extract');
      for (const bin of src.bins) {
        const found = findFile(tmp, bin);
        if (!found) throw new Error(`ffmpeg archive missing ${bin}`);
        const dest = join(paths.tools, bin);
        rmSync(dest, { force: true });
        renameSync(found, dest);
        if (!isWin) chmodSync(dest, 0o755);
      }
      rmSync(archive, { force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  console.log(`Tools ready in ${paths.tools}`);
  for (const f of readdirSync(paths.tools)) console.log(`  ${f}`);
}
