// Single entry for the SEA single-exe (esbuild bundles this + cli + control +
// dev-server + ws into one CJS file). It sets the working-root env the rest of
// the code reads, then dispatches:
//   multicam __control               -> control service        (internal)
//   multicam __server <dir> <port>   -> a TLS dev-server        (internal)
//   multicam <tools|certs|up|down>   -> the CLI
// The internal subcommands are how `up` launches the whole stack from this one
// binary (process.execPath is the exe; spawned children inherit the env below).
import { dirname } from 'node:path';

process.env.MULTICAM_SEA = '1';
// Anchor to the FOLDER THE EXE LIVES IN, not the working directory: when the exe
// is double-clicked, Explorer's cwd is unreliable (often System32), but the exe
// sits next to tools/, phone-pwa/, certs/, etc. An explicit MULTICAM_ROOT wins.
if (!process.env.MULTICAM_ROOT) process.env.MULTICAM_ROOT = dirname(process.execPath);

// Dynamic imports (not static) so the env above is set before any module
// computes its disk root. An async IIFE avoids top-level await (unsupported in
// the CJS output esbuild produces for the SEA blob).
(async () => {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === '__control') {
    const { runControl } = await import('../control/index.mjs');
    await runControl();
  } else if (cmd === '__server') {
    const { runDevServer } = await import('../dev-server.mjs');
    runDevServer(rest[0], rest[1]);
  } else {
    const { runCli } = await import('../cli/index.mjs');
    await runCli(process.argv.slice(2));
  }
})().catch((e) => { console.error(e); process.exit(1); });
