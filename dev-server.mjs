// Reusable HTTPS static server for dev/testing, using the mkcert cert in ./certs.
// Usage:  node dev-server.mjs <dir> [port]   (default dir: phone-pwa, port: 8443)
//   e.g.  node dev-server.mjs operator-dashboard 8444
// Serves static files, /rootCA.pem (phone CA bootstrap), proxies WHIP/WHEP +
// /paths-status to MediaMTX, and proxies /ws/* WebSocket upgrades to the control service.
import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, resolve } from 'node:path';

// MediaMTX WebRTC signalling (localhost). WHIP/WHEP requests are proxied here so
// the phone uses a single TLS origin (this server) — no CORS, no cross-origin TLS.
const MEDIAMTX = { host: '127.0.0.1', port: 8889 };
const CONTROL = { host: '127.0.0.1', port: 9000 };
const isMediaMtxPath = (p) => /\/(whip|whep)(\/|$)/.test(p);

function proxyToMediaMtx(req, res) {
  const upstream = httpRequest(
    { host: MEDIAMTX.host, port: MEDIAMTX.port, method: req.method, path: req.url, headers: req.headers },
    (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); }
  );
  upstream.on('error', (e) => { res.writeHead(502); res.end('MediaMTX unreachable: ' + e.message); });
  req.pipe(upstream);
}

// Read-only recordings API (list / download) lives on the control service.
function proxyToControl(req, res) {
  const upstream = httpRequest(
    { host: CONTROL.host, port: CONTROL.port, method: req.method, path: req.url, headers: req.headers },
    (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); }
  );
  upstream.on('error', (e) => { res.writeHead(502); res.end('Control service unreachable: ' + e.message); });
  req.pipe(upstream);
}

// Read-only path status for the dashboard (MediaMTX control API is localhost-only).
function proxyPathsStatus(res) {
  const up = httpRequest(
    { host: '127.0.0.1', port: 9997, method: 'GET', path: '/v3/paths/list' },
    (u) => { res.writeHead(u.statusCode || 502, { 'content-type': 'application/json', 'cache-control': 'no-store' }); u.pipe(res); }
  );
  up.on('error', () => { res.writeHead(502); res.end('{"items":[]}'); });
  up.end();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const serveDir = resolve(process.argv[2] || join(__dirname, 'phone-pwa'));
const certDir = join(__dirname, 'certs');
const certPath = join(certDir, 'server-cert.pem');
const keyPath = join(certDir, 'server-key.pem');

if (!existsSync(certPath) || !existsSync(keyPath)) {
  console.error('Missing TLS cert. Run setup/make-certs.ps1 first.');
  process.exit(1);
}
if (!existsSync(serveDir)) {
  console.error('Serve directory not found:', serveDir);
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

  // WHIP/WHEP → MediaMTX (same-origin from the phone's perspective).
  if (isMediaMtxPath(urlPath)) { proxyToMediaMtx(req, res); return; }
  if (urlPath === '/paths-status') { proxyPathsStatus(res); return; }
  if (urlPath.startsWith('/api/')) { proxyToControl(req, res); return; }

  if (urlPath === '/rootCA.pem') {
    const ca = join(certDir, 'rootCA.pem');
    if (!existsSync(ca)) { res.writeHead(404); res.end('rootCA.pem not found'); return; }
    res.writeHead(200, {
      'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="multicam-rootCA.pem"',
    });
    createReadStream(ca).pipe(res);
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = normalize(join(serveDir, urlPath));
  if (!filePath.startsWith(serveDir)) { res.writeHead(403); res.end('forbidden'); return; }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, {
    'content-type': MIME[extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store', // dev: never serve a stale page (caused cross-device confusion)
  });
  createReadStream(filePath).pipe(res);
});

// Proxy WebSocket upgrades on /ws/* to the control service (localhost).
// Keeps the coordination channel same-origin (wss on this server) — no separate
// port for the browser, which keeps iOS happy.
server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/ws/')) { socket.destroy(); return; }
  const up = httpRequest({ host: CONTROL.host, port: CONTROL.port, path: req.url, method: req.method, headers: req.headers });
  up.on('upgrade', (upRes, upSocket, upHead) => {
    const headers = Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n${headers}\r\n\r\n`);
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
  });
  up.on('error', () => socket.destroy());
  up.end();
});

const PORT = process.argv[3] || process.env.PORT || 8443;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTPS server on :${PORT} serving ${serveDir}`);
  console.log(`Open https://<this-laptop-LAN-IP>:${PORT}/ on a phone on the same WiFi.`);
});
