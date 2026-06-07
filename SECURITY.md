# Security

## Reporting a vulnerability

Please **don't** open a public issue for security problems. Email
**nicolaasgrob@gmail.com** with the details and I'll respond within a few days.

If you don't get a reply within a week, feel free to open a private GitHub
security advisory on the repo as a fallback.

## Security model (what to assume)

This project is built to run on a **trusted local network** — a venue WiFi or
LAN you control. It does **not** authenticate anyone. The README is explicit
about this:

- Anyone on the same LAN who can reach `https://<laptop-ip>:8443` or `:8444`
  can open the device page or operator dashboard, start/stop recording, and
  download files.
- WebSocket upgrades on `/ws/phone` and `/ws/operator` reject mismatched
  Origins (defends against same-LAN CSRF from a victim's browser tab), but a
  non-browser attacker on the LAN can still spoof Origin.
- The control HTTP API (`:9000`), MediaMTX API (`:9997`), and WHIP/WHEP
  signalling (`:8889`) bind to `127.0.0.1` and aren't reachable from the LAN
  directly.
- **Session import** (`POST /api/sessions/import`, used by the dashboard's
  "Import…" button) is a write surface — it unpacks an uploaded bundle into
  `recordings/`. The archive is parsed in-process and every entry is validated
  (only `recordings/<id>/<file>` with safe single-segment names; absolute, `..`,
  drive-letter, UNC and non-regular entries are rejected) before any byte is
  written, and the manifest is schema-checked. Like the rest of the API it is
  **not authenticated** — within the LAN-trusted model, anyone who can reach the
  dashboard can import. To avoid the network surface entirely, import locally
  instead (`multicam import <bundle.tar>` or the tray "Import session bundle…").
- TLS uses a locally-installed mkcert root CA. Each device trusts it once;
  it's not a public CA.

**Don't expose the studio to the open internet.** If you need to, put it
behind a VPN or a reverse-proxy that adds authentication — both are out of
scope for this project.

## Things that count as security issues
- Path traversal / arbitrary file read or write
- Command injection through any HTTP/WS surface
- WS handlers accepting cross-origin upgrades the Origin check should have
  blocked
- TLS material (private keys, root CA) being served to anyone other than
  intended

## Things that are NOT security issues
- "Anyone on the LAN can do X." That's the documented model — see above.
- Browser warnings about the locally-trusted certificate. That's mkcert's
  whole point.
