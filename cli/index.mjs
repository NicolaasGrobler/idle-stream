#!/usr/bin/env node
// Wireless Multicam Studio — cross-platform launcher.
//   node cli/index.mjs <tools|certs|up|down> [--ip <addr>]
// Or via npm: npm run setup | npm run certs | npm run up | npm run down
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { paths, getLanIP, renderMediamtxConfig, parseIpFlag, isWin } from './platform.mjs';
import { fetchTools } from './tools.mjs';
import { makeCerts, issueCert, issuedCertIp, certExists } from './certs.mjs';

const PORTS = [8443, 8444, 8889, 9000];

// When packaged as a SEA single-exe, the entry sets MULTICAM_SEA. In that mode
// there are no .mjs files to run, so the control service and dev-servers are
// launched by re-invoking this same binary with internal subcommands. In dev,
// they're plain `node <file>.mjs` spawns. Children inherit MULTICAM_ROOT/_SEA.
const IS_SEA = process.env.MULTICAM_SEA === '1';
const svcArgs = (kind, ...extra) => {
  if (kind === 'control') return IS_SEA ? ['__control'] : ['control/index.mjs'];
  return IS_SEA ? ['__server', ...extra] : ['dev-server.mjs', ...extra];
};

function startSvc(name, file, args, cwd) {
  const out = openSync(join(paths.logs, `${name}.out.log`), 'w');
  const err = openSync(join(paths.logs, `${name}.err.log`), 'w');
  const child = spawn(file, args, { cwd, detached: true, stdio: ['ignore', out, err], windowsHide: true });
  child.unref();
  console.log(`  started ${name} (pid ${child.pid})`);
}

// Shared startup checks + per-network prep, used by both `up` (detached) and the
// double-click launcher (foreground). Returns the LAN IP. Throws a friendly
// message if tools/certs aren't set up yet.
function prepare(prefIp) {
  if (!existsSync(paths.mediamtx) || !existsSync(paths.mkcert)) {
    throw new Error('Missing tools. Run once:  multicam tools');
  }
  if (!certExists()) {
    throw new Error('First-time setup needed. Run once:  multicam certs   (installs the local CA + a LAN cert)');
  }
  const ip = getLanIP(prefIp);
  // Keep the TLS cert bound to the current LAN IP. If the network changed since
  // `certs` ran, the leaf's SAN is stale and iOS silently blocks the camera —
  // reissue it (the mkcert CA is unchanged, so phones stay trusted).
  if (issuedCertIp() !== ip) {
    console.log(`LAN IP changed (${issuedCertIp() || 'unknown'} -> ${ip}); re-issuing TLS cert...`);
    issueCert(ip);
  }
  renderMediamtxConfig(ip);
  mkdirSync(paths.logs, { recursive: true });
  return ip;
}

// Headless/scripted start: spawn the stack detached and return. Stop with `down`.
async function up(prefIp) {
  const ip = prepare(prefIp);
  console.log(`Starting studio stack (LAN IP ${ip})...`);
  startSvc('mediamtx', paths.mediamtx, ['mediamtx/mediamtx.gen.yml'], paths.root);
  startSvc('control', process.execPath, svcArgs('control'), paths.root);
  startSvc('phone', process.execPath, svcArgs('server', 'phone-pwa', '8443'), paths.root);
  startSvc('operator', process.execPath, svcArgs('server', 'operator-dashboard', '8444'), paths.root);

  console.log('');
  console.log('Stack up.');
  console.log(`  Phones:   https://${ip}:8443/`);
  console.log(`  Operator: https://localhost:8444/   (or https://${ip}:8444/)`);
  console.log('  Logs:     ./logs/*.log');
  console.log('  Stop:     multicam down');
}

// Stop the stack by freeing its listening ports (catches the services however
// they were started — Node CLI or the legacy PowerShell scripts).
function down() {
  if (isWin) {
    let table = '';
    try { table = execSync('netstat -ano -p tcp', { encoding: 'utf8' }); } catch { /* ignore */ }
    const pids = new Set();
    for (const line of table.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (m && PORTS.includes(Number(m[1]))) pids.add(m[2]);
    }
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' }); console.log(`stopped PID ${pid}`); } catch { /* already gone */ }
    }
  } else {
    for (const port of PORTS) {
      try {
        const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' });
        for (const pid of out.split(/\s+/).filter(Boolean)) {
          try { process.kill(Number(pid), 'SIGKILL'); console.log(`stopped PID ${pid} on :${port}`); } catch { /* gone */ }
        }
      } catch { /* nothing listening */ }
    }
  }
  console.log('Stack stopped.');
}

// Is this Windows process elevated? `net session` only succeeds as admin.
function isAdminWin() {
  try { execSync('net session', { stdio: 'ignore' }); return true; } catch { return false; }
}

// Re-launch this exe elevated (UAC prompt) with the given args, and wait. Used
// for `certs` from the packaged exe, where installing the local CA needs admin.
function relaunchElevated(args) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const argList = args.length ? args.map(q).join(',') : "''";
  const cmd = `Start-Process -FilePath ${q(process.execPath)} -ArgumentList ${argList} -Verb RunAs -Wait`;
  console.log('Requesting administrator access for one-time certificate setup...');
  try {
    execSync(`powershell -NoProfile -Command "${cmd}"`, { stdio: 'inherit' });
  } catch {
    console.error('Elevation was declined — the certificate was not installed.');
    process.exitCode = 1;
  }
}

// Open a URL in the default browser (best-effort, non-blocking). Suppressed by
// MULTICAM_NO_OPEN=1 (used by automated tests of the launcher).
function openBrowser(url) {
  if (process.env.MULTICAM_NO_OPEN === '1') return;
  try {
    const [cmd, args] = isWin ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* no browser — the URLs are printed anyway */ }
}

// A service spawned ATTACHED to this process (so closing the window/Ctrl+C takes
// the whole studio down with it). Logs still go to ./logs.
function startAttached(name, file, args) {
  const out = openSync(join(paths.logs, `${name}.out.log`), 'w');
  const err = openSync(join(paths.logs, `${name}.err.log`), 'w');
  return spawn(file, args, { cwd: paths.root, stdio: ['ignore', out, err], windowsHide: true });
}

function pause(prompt = 'Press Enter to close...') {
  return new Promise((resolve) => {
    try {
      process.stdout.write(prompt);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => resolve());
    } catch { resolve(); }
  });
}

// Double-click / no-arg launcher: a foreground supervisor. Starts the stack
// attached, prints a status banner with the URLs, opens the dashboard, and keeps
// the window open until the user quits (Ctrl+C / close / 'q') or a service dies —
// then stops everything. On a startup error it pauses so the window doesn't just
// vanish (the whole reason a double-clicked CLI is unfriendly).
async function launch(prefIp) {
  let ip;
  try {
    ip = prepare(prefIp);
  } catch (e) {
    console.error('\n  ' + e.message + '\n');
    await pause();
    process.exitCode = 1;
    return;
  }

  const children = [
    startAttached('mediamtx', paths.mediamtx, ['mediamtx/mediamtx.gen.yml']),
    startAttached('control', process.execPath, svcArgs('control')),
    startAttached('phone', process.execPath, svcArgs('server', 'phone-pwa', '8443')),
    startAttached('operator', process.execPath, svcArgs('server', 'operator-dashboard', '8444')),
  ];

  console.log('');
  console.log('  Wireless Multicam Studio — RUNNING');
  console.log('  ----------------------------------');
  console.log(`  Phones:   https://${ip}:8443/`);
  console.log(`  Operator: https://localhost:8444/   (or https://${ip}:8444/)`);
  console.log('');
  console.log('  Opening the dashboard in your browser...');
  console.log("  Close this window (or press Ctrl+C) to stop the studio.");
  console.log('');
  openBrowser('https://localhost:8444/');

  let stopping = false;
  const stop = async (code) => {
    if (stopping) return;
    stopping = true;
    console.log('\n  Stopping studio...');
    for (const c of children) { try { c.kill(); } catch { /* gone */ } }
    try { down(); } catch { /* best effort */ }
    if (code && IS_SEA) await pause();   // keep a failure visible on a double-click
    process.exit(code);
  };

  process.on('SIGINT', () => { void stop(0); });
  process.on('SIGTERM', () => { void stop(0); });
  process.on('SIGHUP', () => { void stop(0); });
  try { process.on('SIGBREAK', () => { void stop(0); }); } catch { /* not on this platform */ }
  for (const c of children) {
    c.on('exit', () => {
      if (!stopping) { console.error('\n  A service stopped unexpectedly — shutting down. See logs/*.err.log'); void stop(1); }
    });
  }

  // Keep the window open and offer a quit key.
  try {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { if (d.charCodeAt(0) === 3 || /^q/i.test(d.trim())) void stop(0); });
  } catch { /* no stdin — the attached children keep us alive */ }
}

function usage() {
  const inv = IS_SEA ? 'multicam' : 'node cli/index.mjs';
  console.log('Wireless Multicam Studio\n');
  console.log(`Usage: ${inv} <command> [--ip <addr>]\n`);
  console.log('  start   start the studio and keep this window open (default when double-clicked)');
  console.log('  tools   download mkcert + MediaMTX + ffmpeg for this OS/arch into ./tools');
  console.log('  certs   install the local CA and issue a LAN TLS cert');
  console.log('  up      start the full stack in the background (stop with `down`)');
  console.log('  down    stop the stack');
}

export async function runCli(args) {
  const [cmd, ...rest] = args;
  const prefIp = parseIpFlag(rest);
  try {
    switch (cmd) {
      case 'tools': await fetchTools(); break;
      case 'certs':
        // Installing the local CA needs admin. From the packaged exe, self-elevate
        // (UAC) so the "first-time setup" shortcut just works; in dev the user
        // runs their own elevated shell if needed.
        if (IS_SEA && isWin && !isAdminWin()) { relaunchElevated(['certs', ...(prefIp ? ['--ip', prefIp] : [])]); break; }
        makeCerts(getLanIP(prefIp));
        break;
      case 'start': await launch(prefIp); break;
      case 'up': await up(prefIp); break;
      case 'down': down(); break;
      case 'help': case '--help': case '-h': usage(); break;
      default:
        if (!cmd && IS_SEA) { await launch(prefIp); break; }   // double-clicked exe -> launcher
        usage();
        if (cmd) process.exitCode = 1;
    }
  } catch (e) {
    console.error(`\nError: ${e.message}`);
    process.exitCode = 1;
  }
}

// Run directly (`node cli/index.mjs ...`). When imported — including by the SEA
// bundle's entry — this stays dormant and the caller invokes runCli().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
