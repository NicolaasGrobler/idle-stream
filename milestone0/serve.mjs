// Milestone 0: minimal HTTPS static server for the getUserMedia gate test.
// Serves this directory over TLS using the mkcert-generated cert in ../certs.
import { createServer } from 'node:https';
import { readFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const certDir = join(__dirname, '..', 'certs');
const certPath = join(certDir, 'server-cert.pem');
const keyPath = join(certDir, 'server-key.pem');

if (!existsSync(certPath) || !existsSync(keyPath)) {
  console.error('Missing TLS cert. Run setup/make-certs.ps1 first.');
  console.error(`Expected:\n  ${certPath}\n  ${keyPath}`);
  process.exit(1);
}

const options = { cert: readFileSync(certPath), key: readFileSync(keyPath) };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(options, (req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // Bootstrap: let phones download the root CA to trust it.
  // application/x-x509-ca-cert makes iOS treat it as an installable profile.
  if (urlPath === '/rootCA.pem') {
    const ca = join(certDir, 'rootCA.pem');
    if (!existsSync(ca)) { res.writeHead(404); res.end('rootCA.pem not found'); return; }
    res.writeHead(200, {
      'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="sermon-studio-rootCA.pem"',
    });
    createReadStream(ca).pipe(res);
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = normalize(join(root, urlPath));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
});

const PORT = process.env.PORT || 8443;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Milestone 0 HTTPS server listening on :${PORT}`);
  console.log(`Open https://<this-laptop-LAN-IP>:${PORT}/ on a phone on the same WiFi.`);
});
