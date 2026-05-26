#!/usr/bin/env node
// Wireless Multicam Studio — cross-platform launcher.
//   node cli/index.mjs <tools|certs|up|down> [--ip <addr>]
// Or via npm: npm run setup | npm run certs | npm run up | npm run down
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { paths, getLanIP, renderMediamtxConfig, parseIpFlag, isWin } from './platform.mjs';
import { fetchTools } from './tools.mjs';
import { makeCerts, issueCert, issuedCertIp, certExists } from './certs.mjs';

const PORTS = [8443, 8444, 8889, 9000];

function startSvc(name, file, args, cwd) {
  const out = openSync(join(paths.logs, `${name}.out.log`), 'w');
  const err = openSync(join(paths.logs, `${name}.err.log`), 'w');
  const child = spawn(file, args, { cwd, detached: true, stdio: ['ignore', out, err], windowsHide: true });
  child.unref();
  console.log(`  started ${name} (pid ${child.pid})`);
}

async function up(prefIp) {
  if (!existsSync(paths.mediamtx) || !existsSync(paths.mkcert)) {
    throw new Error('Missing tools. Run:  npm run setup');
  }
  if (!certExists()) {
    throw new Error('Missing certs. Run:  npm run certs');
  }
  if (!existsSync(paths.venvPython)) {
    throw new Error('Missing control venv. Create it:\n'
      + '  python -m venv control/.venv\n'
      + `  ${isWin ? 'control\\.venv\\Scripts\\pip' : 'control/.venv/bin/pip'} install -r control/requirements.txt`);
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

  console.log(`Starting studio stack (LAN IP ${ip})...`);
  startSvc('mediamtx', paths.mediamtx, ['mediamtx/mediamtx.gen.yml'], paths.root);
  startSvc('control', paths.venvPython, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '9000'], join(paths.root, 'control'));
  startSvc('phone', process.execPath, ['dev-server.mjs', 'phone-pwa', '8443'], paths.root);
  startSvc('operator', process.execPath, ['dev-server.mjs', 'operator-dashboard', '8444'], paths.root);

  console.log('');
  console.log('Stack up.');
  console.log(`  Phones:   https://${ip}:8443/`);
  console.log(`  Operator: https://localhost:8444/   (or https://${ip}:8444/)`);
  console.log('  Logs:     ./logs/*.log');
  console.log('  Stop:     npm run down');
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

function usage() {
  console.log('Wireless Multicam Studio\n');
  console.log('Usage: node cli/index.mjs <command> [--ip <addr>]\n');
  console.log('  tools   download mkcert + MediaMTX for this OS/arch into ./tools');
  console.log('  certs   install the local CA and issue a LAN TLS cert');
  console.log('  up      start the full stack (MediaMTX, control service, dev-servers)');
  console.log('  down    stop the stack');
}

const [cmd, ...rest] = process.argv.slice(2);
const prefIp = parseIpFlag(rest);

try {
  switch (cmd) {
    case 'tools': await fetchTools(); break;
    case 'certs': makeCerts(getLanIP(prefIp)); break;
    case 'up': await up(prefIp); break;
    case 'down': down(); break;
    default:
      usage();
      if (cmd) process.exitCode = 1;
  }
} catch (e) {
  console.error(`\nError: ${e.message}`);
  process.exitCode = 1;
}
