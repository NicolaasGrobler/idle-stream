# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`idle-stream` is the repo; **Wireless Multicam Studio** is the product. It turns
phones/webcams/screen-shares/mics into a synchronized multi-angle recording rig
over a LAN, with no app install and no internet. Devices publish over WebRTC
(WHIP) to **MediaMTX**, which records each stream **copy-only** (no re-encode).
A Node control service coordinates everyone; an operator dashboard shows the live
grid (WHEP) and logs camera switches for the post edit.

Read **plan.md** for the full design rationale and the decisions behind the
architecture — it is the canonical "why" document.

## Commands

```bash
npm install          # one runtime dep (ws); the rest are build-time only
npm run setup        # download mkcert + MediaMTX + ffmpeg into ./tools (cli tools)
npm run certs        # install local CA + issue a LAN TLS cert (auto-detects IP)
npm run up           # start the full stack detached (MediaMTX + control + 2 dev-servers)
npm run down         # stop the stack (frees ports 8443/8444/8889/9000)
npm run up -- --ip 10.0.0.5   # force a specific LAN address

npm test             # node --test over control/test/*.test.mjs
node --test control/test/control.test.mjs   # run a single test file
node --test --test-name-pattern "switch"    # run tests matching a name

npm run build:bundle      # esbuild ESM -> dist/multicam.cjs (single CJS bundle)
npm run build:exe         # full Node SEA single-exe -> dist/multicam(.exe)
npm run build:installer   # Windows Inno Setup installer (Windows-only)
```

There is no linter configured. CI (`.github/workflows/test.yml`) runs `npm ci &&
npm test` on Linux/macOS/Windows.

## Architecture

Four processes are started by the CLI (`cli/index.mjs`), all on the LAN, offline:

- **MediaMTX** (`tools/mediamtx`, config `mediamtx/mediamtx.yml`) — WebRTC
  ingest/egress + copy-only recording to `recordings/<cam>/*.mp4`. Control API on
  localhost:9997, WebRTC signalling on 8889, media over UDP directly device↔MediaMTX.
- **Control service** (`control/index.mjs`, :9000, localhost-only) — the brain.
  Two WebSocket endpoints (`/ws/phone`, `/ws/operator`) plus a read-only HTTP API
  under `/api/*`. Holds all session state in memory.
- **Two dev-servers** (`dev-server.mjs`) — TLS static servers + reverse proxies.
  `phone-pwa` on :8443 (devices), `operator-dashboard` on :8444 (operator). They
  proxy WHIP/WHEP to MediaMTX and `/ws/*`/`/api/*` to the control service so the
  browser only ever sees **one trusted same-origin** (critical: iOS Safari blocks
  the camera otherwise, and same-origin avoids CORS/cross-origin-TLS pain).

Media never touches the Node processes — only HTTPS/WebSocket signalling is
proxied, so the laptop does **zero video encoding during recording**.

### Control service internals (`control/`)

`createService(mtx, opts)` in `index.mjs` is the testable core: it takes a
MediaMTX client and injectable clocks + persistence so tests run hermetic against
a `StubMTX` and `FakeWS`. `runControl()` wires the real `ws` server + HTTP. When
editing behavior, change `createService` and assert via `control/test/`.

- `state.mjs` — `SessionState` (in-memory) + `makeCamera`/`makePhone` factories.
  A **"slot" is a camera id** (e.g. `cam1`), the MediaMTX path a phone publishes
  to. Cameras have `kind` `video` (takeable program angle, has a grid tile) or
  `audio` (a mic, recorded as its own clip, NOT takeable, `link`ed to a camera for
  the export). `snapshot()` is the wire format broadcast to operators.
- `mediamtx.mjs` — thin client for the MediaMTX control API; all calls swallow
  errors because the 2s `reconcileOnce` loop re-asserts desired state.
- `cameras.mjs` / `assignments.mjs` / `switches.mjs` / `settings.mjs` — JSON
  persistence under `data/`. Cameras seed three defaults on first run. Assignments
  persist so a phone keeps its slot across reconnects and control restarts.
- `recordings.mjs` — lists/resolves/deletes recorded files. **All file access is
  traversal-guarded** (single path segment regex + resolve-under-root check) —
  preserve this when touching any file-serving code.
- `exports.mjs` + `http-range.mjs` — render a switch-log session into one program
  MP4 via bundled ffmpeg (re-encode; the per-angle clips stay the lossless
  masters). Range-request serving so a `<video>` can seek (Safari requires 206).

### Key behaviors to preserve

- **Persistent phone id**: the phone supplies its own id (localStorage); a
  reconnect re-attaches to the existing record and keeps its slot rather than
  appearing as a new device.
- **Reconcile loop** (every 2s): survives MediaMTX restarts (re-adds paths), grows
  the recording set when a camera goes live mid-take, and auto-stops a recording
  30s (`AUTO_STOP_GRACE_S`) after the last publisher drops.
- **Synchronized record**: all ready cameras get `setRecord(true)` together with
  per-camera start stamps for post alignment; switches are logged as offsets from
  session start.
- **Same-origin WS guard**: upgrades are rejected unless `Origin` host == `Host`
  (both in `dev-server.mjs` and `control/index.mjs`). Don't loosen this — it's the
  defense against a malicious LAN page driving the sockets from a victim's tab.

### Frontends

`operator-dashboard/index.html` (~1580 lines) and `phone-pwa/index.html` are
**single self-contained HTML files** with inline CSS+JS, no build step and no
framework. The only vendored dep is `phone-pwa/vendor/qrcode.js`. Edit the HTML
directly. `phone-pwa/setup.html` is the per-phone CA-trust guide.

### Packaging (`build/`, `cli/`)

`build-sea.mjs` bundles the ESM sources + `ws` into one CJS file with esbuild,
then embeds it in a copy of the node binary (Node SEA + postject) and stamps a
Windows icon/version via `resedit`. The Go tools stay external in `tools/`.

The dual dev/SEA mode is everywhere: source files don't exist on disk in the
packaged exe, so **paths anchor to `process.env.MULTICAM_ROOT`** (set by the
launcher) with `import.meta.url` only as a dev fallback. `IS_SEA` switches between
spawning `node <file>.mjs` (dev) and re-invoking the same exe with internal
subcommands `__control`/`__server` (packaged). Preserve this pattern when adding
any new spawned process or file path.

Version comes **only** from `package.json` — it's read at build time into the SEA
exe metadata, the installer, and the tray. Never hardcode a version elsewhere.

### Networking / certs

`cli/platform.mjs` auto-detects the LAN IPv4 (skips loopback/VPN/virtual
adapters, prefers 192.168 > 10 > 172.16-31). `npm run up` re-detects the IP each
start and re-issues the TLS leaf cert if it changed (the mkcert CA is unchanged,
so phones stay trusted — no re-distributing the root). The operator uses
`studio.localhost` (auto-resolves to loopback, added to the cert SANs).
`mediamtx.gen.yml` is generated from `mediamtx.yml` with the IP injected.

There are PowerShell equivalents in `setup/` and `scripts/` (the repo is Windows-
primary) that do the same as the cross-platform Node CLI.
