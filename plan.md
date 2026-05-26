# Church Sermon Multi-Cam Recording System

A local-network recording studio. Phones act as wireless cameras streaming over WebRTC (WHIP) to a server that records each angle losslessly. An operator dashboard coordinates the phones (assign cameras, arm → preview → record) and shows all feeds live. The final edit is cut in post from the clean per-angle files.

> **Status (living doc).** This spec now reflects what is actually built. Milestones 0–3 plus the operator control service, dynamic cameras, and the editorial switch log are implemented and validated on real iOS + Android phones. Live-switched RTMP remains deliberately out of scope (see [Future](#future-live-streaming-not-v1)). Implementation status is tracked in [Build Status](#build-status).

## Goals

1. **Wireless cameras**: Phones run a browser PWA — no app install. Each streams camera + mic over local WiFi.
2. **Operator coordination**: Phones connect "armed" and wait; the operator assigns each to a camera slot and starts everyone together.
3. **Multi-angle live preview**: Operator sees all feeds simultaneously in a low-latency browser grid.
4. **Two-stage recording**: Preview (frame/check) without recording, then **Record** captures every angle **without re-encoding**, with a synchronized start.
5. **Self-contained**: Runs entirely on a local network. No internet at service time.
6. **Future (not v1): optional live streaming** to RTMP — deferred; see [Future](#future-live-streaming-not-v1).

## Key Architecture Decisions

Grounded in research done before building. Killer constraints: **avoid re-encoding N streams on a laptop**, **run offline on a LAN**, and **work on iOS Safari**.

- **Don't build the media plane — `aiortc` re-encodes everything.** It decodes + re-encodes every stream on one asyncio loop (no passthrough; maintainer rejected it), topping out ~2 streams on a laptop. Rejected.
- **MediaMTX for ingest + lossless recording.** Single Go binary: WHIP ingest from browsers, **copy-only fMP4 recording** (~zero CPU), WHEP republish, runtime path + record control via its HTTP API. This is the whole media plane.
- **Single TLS origin via reverse proxy.** iOS Safari blocks cross-origin WHIP fetches and self-signed certs. The Node dev-server terminates TLS and reverse-proxies WHIP/WHEP, `/paths-status`, and the control WebSocket (`/ws/*`) to localhost services. Phones/browser only ever see one trusted origin. **This was the fix that made iOS work.**
- **Recording toggled at runtime, off by default.** MediaMTX records only when the operator clicks Record, via a per-path config patch. Verified on real phones that toggling record **does not drop the publisher**, enabling the two-stage preview→record flow and a synchronized multi-cam start.
- **Force H.264 end-to-end** so recordings stay copy-only (iOS sends H.264 by default; the phone reorders codec preferences to put H.264 first).
- **TLS that iOS trusts: `mkcert` local CA + LAN-IP cert.** Self-signed "accept the risk" silently blocks `getUserMedia` on iOS. Install the mkcert root on each phone once; bind the cert to the laptop's static LAN IP (IP SAN, not `.local`). See [Secure Context & TLS](#secure-context--tls-setup).
- **Cameras are dynamic and operator-owned.** The control service is the source of truth for the camera list (persisted to `data/cameras.json`); it creates/deletes MediaMTX paths at runtime via the API. No camera list is hardcoded.

## Architecture Overview

```mermaid
graph LR
  subgraph Phones["Phones (browser PWA, WHIP)"]
    P1[Phone A]
    P2[Phone B]
  end

  subgraph Laptop["Server laptop (LAN, offline)"]
    subgraph Edge["Node dev-servers (TLS)"]
      D1["phone server :8443"]
      D2["operator server :8444"]
    end
    CTRL["Control service (FastAPI) :9000<br/>cameras, slots, arm/preview/record<br/>data/cameras.json"]
    MMTX["MediaMTX<br/>WHIP/WHEP :8889 (localhost)<br/>UDP :8189 media · API :9997"]
    DISK[("recordings/&lt;cam&gt;/*.mp4")]
  end

  P1 -->|WHIP H.264| D1
  P2 -->|WHIP H.264| D1
  D1 -->|proxy WHIP| MMTX
  D1 -->|proxy /ws/phone| CTRL
  D2 -->|proxy WHEP, /paths-status| MMTX
  D2 -->|proxy /ws/operator| CTRL
  CTRL -->|add/del path, record on/off| MMTX
  MMTX -->|copy-only| DISK
```

Media (UDP :8189) flows directly phone↔MediaMTX. Only HTTP/WS signalling is proxied. The server does no video encoding — MediaMTX muxes copy-only; the operator's browser decodes the WHEP grid client-side.

## Tech Stack & Ports

| Component | Tech | Port | Exposure |
|---|---|---|---|
| Phone server | Node `dev-server.mjs` (static + TLS + proxy) | 8443 | LAN (firewall) |
| Operator server | same, `PORT=8444` | 8444 | LAN / localhost |
| Control service | Python FastAPI + uvicorn | 9000 | localhost |
| MediaMTX WHIP/WHEP | Go binary | 8889 | localhost (proxied) |
| MediaMTX media (ICE) | — | 8189/udp | LAN (firewall) |
| MediaMTX API | — | 9997 | localhost |

Firewall rules needed on the LAN: **8443/tcp**, **8444/tcp** (if operator is remote), **8189/udp**.

## Secure Context & TLS Setup

`getUserMedia` requires a secure context; on a LAN IP over `http://` it's unavailable. **iOS Safari does not honor "accept the risk" on a self-signed cert** — it silently blocks the camera. Fix: a locally-trusted cert via **mkcert**.

1. Static LAN IP on the router (dev: `192.168.0.52`).
2. `setup\fetch-tools.ps1` (downloads mkcert + MediaMTX), then `setup\make-certs.ps1` — installs the local CA and issues a cert with the LAN IP as an **IP SAN** (+ `localhost`, `127.0.0.1`), into `certs/`.
3. Phones download `rootCA.pem` (served at `https://<ip>:8443/rootCA.pem`) and trust it:
   - **iOS:** install profile, **then** Settings ▸ General ▸ About ▸ Certificate Trust Settings → enable full trust (both steps).
   - **Android:** Settings ▸ Security ▸ Install a certificate ▸ CA certificate.

Cert constraints (iOS 13+): hostname/IP in a SAN, SHA-2, RSA ≥ 2048, validity ≤ 825 days — mkcert satisfies these. Avoid `.local` (unreliable on iOS); use the IP.

**Switching networks is automatic.** The LAN IP is auto-detected (shared helper `setup/lan-ip.ps1`; override with `-Ip`). `make-certs.ps1` records the IP it issued for to `certs/.lan-ip`; on each `dev-up.ps1` the IP is re-checked and the leaf cert is **re-issued automatically if it changed** (the mkcert root CA is unchanged, so phones stay trusted — no re-install, no re-distributing `rootCA.pem`). MediaMTX's advertised WebRTC host is injected the same way. So moving from a test network to a venue needs no hand-editing — just run `dev-up.ps1` there.

## Components

### Phone PWA (`phone-pwa/`)
- Landing: phone name + camera (front/back) → **Join** (one gesture acquires the camera, requests wake lock, connects the control WebSocket, registers).
- Then **armed**: shows the assigned camera's label and waits. Publishes via **WHIP only on the operator's command**, forcing H.264 and a 5 Mbps target bitrate. Shows live/standby, bitrate, and a REC badge mirroring session state.
- WebSocket auto-reconnect with backoff.

### MediaMTX (`mediamtx/mediamtx.yml`)
- WebRTC on `127.0.0.1:8889` (no TLS — the proxy terminates it), media on UDP `:8189`, API on `127.0.0.1:9997`. RTSP/RTMP/HLS/SRT disabled.
- `record: no` default (operator-controlled), copy-only fMP4 to `recordings/<path>/...`, `recordDeleteAfter: 0` (never auto-delete). **No camera paths declared** — the control service manages them.
- The committed config is **network-agnostic** (`webrtcIPsFromInterfaces: yes` gathers every interface IP as an ICE candidate, including the LAN one; `webrtcAdditionalHosts: []`). `dev-up.ps1` renders `mediamtx.gen.yml` with the detected LAN IP injected and launches from that — nothing per-network is committed.

### Control service (`control/`)
FastAPI on `:9000`, two WebSocket endpoints proxied same-origin:
- **`/ws/phone`** — phones register (`{name}` → assigned an id), report publishing status; receive `assigned`, `command:{publish|stop}`, `recording` messages.
- **`/ws/operator`** — receives a full `state` snapshot on every change and accepts: `addCamera`/`renameCamera`/`removeCamera`, `assign`/`unassign`, `startPreview`/`stopPreview`, `startRecording`/`stopRecording`, and `switch` (take a camera as the program feed).
- Enforces **one phone per camera** (assignment evicts a prior holder). Records only slots that are **live in MediaMTX at the moment Record is pressed** (checks the API, not a stale flag).
- Owns the camera list (persisted `data/cameras.json`); creates/deletes MediaMTX paths via the API and re-ensures them every 2s (survives a MediaMTX restart).
- **Switch log.** Each recording is a session. On Record it stamps **per-camera record-start timestamps** and opens an empty switch log; each `switch` (operator "take cam N", ignored unless recording, consecutive duplicates skipped) appends `{wall-clock, offset-from-session-start, camId, label}`. On Stop the session — timing, per-camera start stamps, and the ordered takes — is appended to `data/switches.json` for the post-production cut. Offsets map directly onto the recording timeline.

### Operator dashboard (`operator-dashboard/`)
- **Cameras panel**: add (next free `camN`), inline rename, remove (× — deletes the MediaMTX path and unassigns phones).
- **Phone roster**: each phone's slot dropdown (taken slots disabled), live/standby badge.
- **Session controls**: Start Preview (all), Stop Preview, Record / Stop Recording, live count, recording timer.
- **WHEP multiview**: dynamic tiles that grow/shrink with the camera list, per-tile inbound bitrate, and a **layout selector (Auto / 2 / 3 / 4 per row)** remembered in `localStorage`.
- **Switching**: while recording, click a tile — or press number keys **1–9** (vision-mixer style, by camera order) — to "take" that camera as the program feed. The current program tile gets a red **PGM** tally border; a side-panel **switch log** lists every take with its offset. Off-air the controls no-op.

## Camera & Recording Model

- A camera = `{id: "camN", label}`. The id is the MediaMTX path; the label is editable. New cameras get the next free `camN`.
- **Two-stage**: Start Preview makes assigned phones publish (no recording). Record patches `record: on` for every live slot — recording starts from that instant, across all cameras together, without dropping publishers. Stop Recording patches them off.
- Recording is copy-only H.264 + Opus → fMP4. Quality equals what the phone streams (5 Mbps target), not the phone's native camera quality.
- **Switch log = editorial cut list.** A session spans Record→Stop. The operator's takes are logged as offsets from session start (plus absolute wall-clock + per-camera record-start stamps) to `data/switches.json`, so the editor can cut between the clean per-angle files in post. It records intent, not a switched output — no live program feed is produced (see [Future](#future-live-streaming-not-v1)).

## Repository Layout

```
idle-stream/
├── mediamtx/mediamtx.yml         # MediaMTX config template (no paths, no LAN IP); dev-up renders mediamtx.gen.yml
├── control/
│   ├── app/{main,state,mediamtx,cameras,switches}.py
│   ├── requirements.txt
│   └── .venv/                     # (gitignored)
├── phone-pwa/index.html          # phone capture client (WHIP + control WS)
├── operator-dashboard/index.html # operator UI (control WS + WHEP grid)
├── milestone0/                   # standalone getUserMedia diagnostic (keep for new-device cert checks)
├── milestone1/                   # standalone publisher (superseded by phone-pwa; kept as a no-orchestration test)
├── dev-server.mjs                # TLS static server + WHIP/WHEP/WS reverse proxy
├── setup/{fetch-tools,make-certs,lan-ip}.ps1   # lan-ip.ps1: shared LAN IP detection
├── scripts/{dev-up,dev-down}.ps1 # start/stop the whole stack
├── tools/                        # mkcert.exe, mediamtx.exe (gitignored; fetch-tools re-downloads)
├── certs/  data/  recordings/  logs/   # all gitignored
└── plan.md
```

## Running It

```powershell
.\setup\fetch-tools.ps1          # once: download mkcert + MediaMTX
.\setup\make-certs.ps1           # once: local CA + cert for the LAN IP; trust rootCA on phones
python -m venv control\.venv; control\.venv\Scripts\pip install -r control\requirements.txt   # once
.\scripts\dev-up.ps1             # start MediaMTX + control + both dev-servers (logs in .\logs)
# Phones:   https://<LAN-IP>:8443/      Operator: https://localhost:8444/
.\scripts\dev-down.ps1           # stop everything
```

## Build Status

- **M0 — iOS camera over LAN HTTPS**: done (mkcert CA, validated on a real iPhone).
- **M1 — phone → MediaMTX → lossless recording**: done (copy-only H.264+Opus, ffprobe-verified).
- **M2/M3 — operator WHEP preview + multiple cameras**: done (multi-cam simultaneous record + live grid).
- **Control service / orchestration**: done — armed phones, operator slot assignment with collision prevention, two-stage preview→record, synchronized start, runtime record toggle (verified no publisher drop).
- **Dynamic cameras**: done — add/rename/remove, persisted, MediaMTX paths managed at runtime.
- **Grid layout selector**: done (Auto / 2 / 3 / 4).
- **Switch log**: done — tile-click / 1–9 "take cam N" with PGM tally, per-camera record-start stamps, sessions appended to `data/switches.json`. Server-flow validated (handlers driven offline with a stubbed MediaMTX); dashboard rendering validated in a browser. Not yet exercised end-to-end with a live phone publisher.

### Next
- **Stop Session + recordings list**: see/download captured files from the dashboard (per-camera start stamps already recorded by the switch log, so files and `switches.json` can be aligned).
- **Phone polish**: persistent phone id (survive WiFi blips without losing the slot), landscape lock, low-battery warning.
- **Pre-flight check** screen (all cameras publishing, codec H.264, recording writes, audio present).

### Known limitations
- A phone that drops its WebSocket reconnects as a **new** entry and loses its slot assignment (needs a persistent phone id).
- Recording state doesn't auto-clear if every phone drops — the operator clicks Stop Recording.
- Setup scripts are **Windows/PowerShell only** (`.ps1`); the runtime (Node dev-server, MediaMTX, mkcert) is cross-platform but macOS/Linux launch scripts don't exist yet.

## Future: Live Streaming (not v1)

Pushing a switched feed to RTMP needs **one persistent encoder fed by a switchable compositor** (restarting/swapping an encoder drops the stream). The proven answer is **OBS driven over obs-websocket** (scene switching never restarts the encoder); cameras feed OBS as RTSP/WHEP sources from MediaMTX. Do **not** hand-roll an FFmpeg/GStreamer switcher. A lighter middle ground: MediaMTX can restream a **single fixed camera** to RTMP with no OBS and no switching. Deferred until the requirement is real.

## Testing

- **Manual smoke (per service)**: phones Join → assign → Start Preview → Record → Stop → verify files. Validated.
- **Control service**: WebSocket CRUD (camera add/rename/remove) exercised against MediaMTX + persistence.
- **Future automated**: spin up MediaMTX + control; Playwright drives the phone PWA with `--use-fake-device-for-media-stream` and the dashboard end-to-end.

## Reference Reading
- MediaMTX (WHIP/WHEP, recording, runtime API): https://github.com/bluenviron/mediamtx
- WHIP (RFC 9725): https://datatracker.ietf.org/doc/rfc9725/
- mkcert: https://github.com/FiloSottile/mkcert
- iOS trusting local roots: https://support.apple.com/en-us/102390 and https://support.apple.com/en-us/103769
- MDN getUserMedia (secure context): https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- (Future/RTMP) obs-websocket: https://github.com/obsproject/obs-websocket
