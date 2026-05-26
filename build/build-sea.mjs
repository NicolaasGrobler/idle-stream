// Build the `multicam` Node SEA single-exe.
//
// SEA embeds ONE CommonJS script into a copy of the node binary, so we first
// bundle the ESM sources (cli + control + dev-server) and the one npm dep (ws)
// into a single CJS file with esbuild, then run Node's SEA blob + postject flow.
// The Go binaries (mkcert, mediamtx, ffmpeg) stay external in tools/.
//
//   node build/build-sea.mjs --bundle-only   # just produce dist/multicam.cjs
//   node build/build-sea.mjs                 # full single-exe in dist/
import { build } from 'esbuild';
import { inject } from 'postject';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const BUNDLE = join(DIST, 'multicam.cjs');
const BLOB = join(DIST, 'sea-prep.blob');
const CONFIG = join(DIST, 'sea-config.json');
const EXE = join(DIST, isWin ? 'multicam.exe' : 'multicam');
// Node's documented SEA fuse sentinel.
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

async function bundle() {
  mkdirSync(DIST, { recursive: true });
  await build({
    entryPoints: [join(ROOT, 'build', 'entry.mjs')],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    // ws optionally requires these native addons and degrades gracefully without
    // them; keep them external so the pure-JS path is bundled.
    external: ['bufferutil', 'utf-8-validate'],
    logLevel: 'info',
  });
  console.log(`Bundled -> ${BUNDLE}`);
}

async function makeExe() {
  writeFileSync(CONFIG, JSON.stringify({
    main: BUNDLE,
    output: BLOB,
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
  }, null, 2));

  console.log('Generating SEA blob...');
  execFileSync(process.execPath, ['--experimental-sea-config', CONFIG], { stdio: 'inherit' });

  rmSync(EXE, { force: true });
  copyFileSync(process.execPath, EXE);

  // Inject via postject's programmatic API (the CLI shim doesn't spawn cleanly
  // on Windows). This appends the SEA blob as a resource in the node copy.
  console.log('Injecting blob with postject...');
  await inject(EXE, 'NODE_SEA_BLOB', readFileSync(BLOB), {
    sentinelFuse: FUSE,
    machoSegmentName: isMac ? 'NODE_SEA' : undefined,
  });

  if (!isWin) chmodSync(EXE, 0o755);

  await stampIcon();

  console.log(`\nSingle-exe ready -> ${EXE}`);
  console.log('Run it from a working dir laid out like the repo (tools/, certs/, phone-pwa/, operator-dashboard/, mediamtx/).');
}

// Give the Windows exe a real icon + metadata (it's otherwise a copy of node.exe
// and shows Node's icon). rcedit edits PE resources, so this is Windows-only.
async function stampIcon() {
  if (!isWin) { console.log('Icon step skipped (Windows-only; rcedit edits PE resources).'); return; }
  try {
    const { default: pngToIco } = await import('png-to-ico');
    const { rcedit } = await import('rcedit');
    const ico = await pngToIco(join(ROOT, 'icon.png'));
    const icoPath = join(DIST, 'multicam.ico');
    writeFileSync(icoPath, ico);
    await rcedit(EXE, {
      icon: icoPath,
      'version-string': {
        ProductName: 'Wireless Multicam Studio',
        FileDescription: 'Wireless Multicam Studio',
        CompanyName: 'OpenIdle',
        OriginalFilename: 'multicam.exe',
      },
    });
    console.log('Stamped exe icon + version metadata.');
  } catch (e) {
    console.warn('Icon step skipped:', e.message);
  }
}

const bundleOnly = process.argv.includes('--bundle-only');
await bundle();
if (!bundleOnly) {
  if (!existsSync(BUNDLE)) throw new Error('bundle missing');
  await makeExe();
}
