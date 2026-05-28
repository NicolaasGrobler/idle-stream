// mkcert-backed TLS cert management. The local CA is installed once (ensureCa);
// the leaf cert is (re)issued for whatever LAN IP we're on, and the IP it was
// issued for is recorded so `up` can detect a network change and reissue.
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { paths, OPERATOR_HOST } from './platform.mjs';

function caRoot() {
  return execFileSync(paths.mkcert, ['-CAROOT'], { encoding: 'utf8' }).trim();
}

// Install the mkcert root CA into the OS trust store. Interactive (may prompt
// for elevation on macOS/Linux). Run once during setup, not on every launch.
function ensureCa() {
  execFileSync(paths.mkcert, ['-install'], { stdio: 'inherit' });
}

// Issue the leaf cert for `ip` (+ localhost) and copy the root CA out for phones.
// Uses the already-installed CA, so this does not modify the trust store.
export function issueCert(ip) {
  mkdirSync(paths.certs, { recursive: true });
  execFileSync(
    paths.mkcert,
    ['-cert-file', 'server-cert.pem', '-key-file', 'server-key.pem', ip, 'localhost', '127.0.0.1', OPERATOR_HOST],
    { cwd: paths.certs, stdio: 'inherit' },
  );
  copyFileSync(join(caRoot(), 'rootCA.pem'), join(paths.certs, 'rootCA.pem'));
  writeFileSync(paths.certIpFile, ip);
}

export function issuedCertIp() {
  try {
    return readFileSync(paths.certIpFile, 'utf8').trim();
  } catch {
    return '';
  }
}

export function certExists() {
  return existsSync(join(paths.certs, 'server-cert.pem'));
}

// Full one-time setup: install CA, then issue the leaf for `ip`.
export function makeCerts(ip) {
  console.log(`Binding certificate to LAN IP: ${ip}`);
  ensureCa();
  issueCert(ip);
  console.log('');
  console.log(`  Cert:    ${join(paths.certs, 'server-cert.pem')}`);
  console.log(`  Root CA: ${join(paths.certs, 'rootCA.pem')}   (install this on each device)`);
  console.log('');
  console.log('Device setup (one-time): browse to https://' + ip + ':8443/rootCA.pem and trust it.');
  console.log('  iOS:     install profile, then Settings > General > About > Certificate Trust Settings > enable full trust');
  console.log('  Android: Settings > Security > Install a certificate > CA certificate');
}
