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
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
// postject and rcedit edit the 86MB exe in place; on an OneDrive/AV-watched repo
// the file gets locked and rcedit hangs. So build the exe in a temp dir OUTSIDE
// the synced tree, then copy the finished binary into dist/ as a single write.
const WORK = join(tmpdir(), 'multicam-sea-build');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const EXE_NAME = isWin ? 'multicam.exe' : 'multicam';
const BUNDLE = join(DIST, 'multicam.cjs');
const BLOB = join(WORK, 'sea-prep.blob');
const CONFIG = join(WORK, 'sea-config.json');
const WORK_EXE = join(WORK, EXE_NAME);
const EXE = join(DIST, EXE_NAME);
// Node's documented SEA fuse sentinel.
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
// Single source of truth for the version: package.json. Stamped into the exe's
// PE VersionInfo below, so Windows (file properties, Add/Remove Programs) and the
// tray (which reads the exe's ProductVersion) all report the real version.
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const [V_MAJ, V_MIN, V_PAT] = VERSION.split('.').map((n) => parseInt(n, 10) || 0);

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
    // Bake the version into the bundle so the packaged app (no package.json on
    // disk) can serve it to the dashboard. Single source of truth = package.json.
    define: { __MULTICAM_VERSION__: JSON.stringify(VERSION) },
    logLevel: 'info',
  });
  console.log(`Bundled -> ${BUNDLE}`);
}

async function makeExe() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  writeFileSync(CONFIG, JSON.stringify({
    main: BUNDLE,
    output: BLOB,
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
  }, null, 2));

  console.log('Generating SEA blob...');
  execFileSync(process.execPath, ['--experimental-sea-config', CONFIG], { stdio: 'inherit' });

  copyFileSync(process.execPath, WORK_EXE);

  // Inject via postject's programmatic API (the CLI shim doesn't spawn cleanly
  // on Windows). This appends the SEA blob as a resource in the node copy.
  console.log('Injecting blob with postject...');
  await inject(WORK_EXE, 'NODE_SEA_BLOB', readFileSync(BLOB), {
    sentinelFuse: FUSE,
    machoSegmentName: isMac ? 'NODE_SEA' : undefined,
  });

  if (!isWin) chmodSync(WORK_EXE, 0o755);

  await stampIcon();

  // Move the finished binary into dist/ as one write (nothing holds it open).
  mkdirSync(DIST, { recursive: true });
  rmSync(EXE, { force: true });
  copyFileSync(WORK_EXE, EXE);
  if (!isWin) chmodSync(EXE, 0o755);
  rmSync(WORK, { recursive: true, force: true });

  console.log(`\nSingle-exe ready -> ${EXE}`);
  console.log('Place it in a folder containing tools/, phone-pwa/, operator-dashboard/, mediamtx/ and the');
  console.log('writable certs/ data/ recordings/ exports/ logs/ (it anchors to its own folder, not the cwd).');
}

// Give the Windows exe a real icon + metadata (it's otherwise a copy of node.exe
// and shows Node's icon). Uses resedit — a pure-JS PE resource editor that edits
// the binary in memory (no spawned helper, which is what made rcedit hang under
// AV here). Windows-only since it rewrites PE resources.
async function stampIcon() {
  if (!isWin) { console.log('Icon step skipped (Windows-only PE resources).'); return; }
  try {
    const { default: pngToIco } = await import('png-to-ico');
    const { Data, NtExecutable, NtExecutableResource, Resource } = await import('resedit');

    // ignoreCert: node.exe ships signed; postject already invalidated that sig,
    // and we're editing resources, so drop the certificate table while parsing.
    const exe = NtExecutable.from(readFileSync(WORK_EXE), { ignoreCert: true });
    const res = NtExecutableResource.from(exe);
    const iconFile = Data.IconFile.from(await pngToIco(join(ROOT, 'icon.png')));
    Resource.IconGroupEntry.replaceIconsForResource(
      res.entries, 1, 1033, iconFile.icons.map((i) => i.data),
    );
    const vi = Resource.VersionInfo.createEmpty();
    vi.setFileVersion(V_MAJ, V_MIN, V_PAT, 0, 1033);
    vi.setProductVersion(V_MAJ, V_MIN, V_PAT, 0, 1033);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: 'Wireless Multicam Studio',
      FileDescription: 'Wireless Multicam Studio',
      CompanyName: 'OpenIdle',
      OriginalFilename: 'multicam.exe',
      ProductVersion: VERSION,
      FileVersion: VERSION,
    });
    vi.outputToResourceEntries(res.entries);
    res.outputResource(exe);
    writeFileSync(WORK_EXE, Buffer.from(exe.generate()));
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
// Force exit: a timed-out rcedit child can otherwise keep the event loop alive.
process.exit(0);
