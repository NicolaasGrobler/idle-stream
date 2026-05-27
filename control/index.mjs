// Control service: coordinates phones and the operator dashboard.
//
// Phones connect (armed) and wait. The operator manages the camera list (add /
// rename / remove), assigns each phone to a camera, starts the preview (phones
// begin publishing via WHIP), then starts/stops recording. Two WebSocket
// endpoints, proxied same-origin by the dev-server so phones/browser only ever
// see the trusted origin. Cameras are persisted to data/cameras.json.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

import { SessionState, makeCamera, makePhone } from './state.mjs';
import { MediaMTX } from './mediamtx.mjs';
import * as camerasStore from './cameras.mjs';
import * as switchesStore from './switches.mjs';
import * as recordingsStore from './recordings.mjs';
import * as assignmentsStore from './assignments.mjs';
import * as exportsStore from './exports.mjs';
import * as settingsStore from './settings.mjs';

// Auto-stop a recording this many seconds after the last publisher drops (e.g.
// the event ended). The grace window tolerates brief WiFi blips — a phone that
// reconnects within it resumes publishing and the timer resets.
const AUTO_STOP_GRACE_S = 30;

const randId = () => randomBytes(4).toString('hex');   // 8 hex chars, like uuid4().hex[:8]
const round3 = (x) => Math.round(x * 1000) / 1000;
const isoOf = (ts) =>
  ts === null || ts === undefined ? null : new Date(ts * 1000).toISOString().replace('Z', '+00:00');

// Build a control service around a MediaMTX client. Factored so tests can drive
// the handlers with a stubbed MediaMTX and a fake WebSocket, and inject clocks.
export function createService(mtx, opts = {}) {
  const autoStopGraceS = opts.autoStopGraceS ?? AUTO_STOP_GRACE_S;
  const now = opts.now ?? (() => Date.now() / 1000);            // wall clock (epoch seconds)
  const monotonic = opts.monotonic ?? (() => performance.now() / 1000);
  // Persistence is injectable so tests stay hermetic (no writes to data/).
  const saveCameras = opts.saveCameras ?? camerasStore.save;
  const appendSession = opts.appendSession ?? switchesStore.appendSession;
  const loadCameras = opts.loadCameras ?? camerasStore.load;
  const saveAssignments = opts.saveAssignments ?? assignmentsStore.save;
  const loadAssignments = opts.loadAssignments ?? assignmentsStore.load;
  const saveSettings = opts.saveSettings ?? settingsStore.save;
  const loadSettings = opts.loadSettings ?? settingsStore.load;
  const clampBitrate = settingsStore.clampBitrate;
  // {phoneId: {name, slot}} mirror, persisted so a restart restores assignments.
  const assignments = loadAssignments();

  const state = new SessionState();
  state.globalBitrate = loadSettings().globalBitrate;   // operator-tunable default
  const operators = new Set();
  const phoneSockets = new Map();
  let emptySince = null;

  function wsSend(ws, payload) {
    try {
      ws.send(JSON.stringify(payload), () => {});
    } catch {
      /* socket gone */
    }
  }

  function broadcastState() {
    const msg = JSON.stringify({ type: 'state', ...state.snapshot() });
    for (const ws of [...operators]) {
      try {
        ws.send(msg, (err) => { if (err) operators.delete(ws); });
      } catch {
        operators.delete(ws);
      }
    }
  }

  function sendPhone(phoneId, payload) {
    const ws = phoneSockets.get(phoneId);
    if (ws) wsSend(ws, payload);
  }

  function assignedMsg(slot) {
    return { type: 'assigned', slot, label: slot ? state.labelFor(slot) : null };
  }

  // The publish command carries the effective bitrate so the phone applies it on
  // connect (no separate round-trip needed for the common case).
  function publishCmd(slot) {
    return { type: 'command', action: 'publish', slot, bitrate: state.effectiveBitrate(slot) };
  }

  // Push the current effective bitrate to every assigned phone (used after a
  // global or per-camera change so phones adjust mid-session without a
  // renegotiation). The phone applies it live via setParameters.
  function broadcastBitrates() {
    for (const p of state.phones.values()) {
      if (p.slot) sendPhone(p.id, { type: 'bitrate', bitrate: state.effectiveBitrate(p.slot) });
    }
  }

  function persistCameras() {
    saveCameras(state.cameras);
  }

  // Merge current phones into the persisted assignment map (keeps entries for
  // phones not currently connected, e.g. ones that haven't reconnected yet
  // after a restart) and write it.
  function persistAssignments() {
    for (const p of state.phones.values()) assignments[p.id] = { name: p.name, slot: p.slot };
    saveAssignments(assignments);
  }

  // Turn recording off for every path and finalize the switch-log session.
  // Shared by the operator's Stop Recording and the reconcile loop's auto-clear.
  async function stopRecording() {
    for (const cam of state.cameraIds()) {
      await mtx.setRecord(cam, false);
    }
    if (state.sessionId) {                       // finalize the editorial switch log
      const stopped = now();
      appendSession({
        sessionId: state.sessionId,
        name: state.sessionName,
        startedAt: state.recordingStartedAt,
        startedAtIso: isoOf(state.recordingStartedAt),
        stoppedAt: stopped,
        stoppedAtIso: isoOf(stopped),
        durationSec: round3(stopped - (state.recordingStartedAt || stopped)),
        cameras: Object.entries(state.cameraRecordStarted).map(([cid, ts]) => {
          const c = state.cameras.find((x) => x.id === cid);
          return {
            id: cid,
            label: state.labelFor(cid) || cid,
            kind: c && c.kind === 'audio' ? 'audio' : 'video',
            link: c ? c.link ?? null : null,
            recordStartedAt: ts,
            recordStartedAtIso: isoOf(ts),
          };
        }),
        switches: state.switches,
      });
    }
    state.recording = false;
    state.recordingStartedAt = null;
    state.sessionId = null;
    state.sessionName = null;
    state.cameraRecordStarted = {};
    state.switches = [];
    for (const pid of [...phoneSockets.keys()]) {
      sendPhone(pid, { type: 'recording', on: false });
    }
    broadcastState();
  }

  // ----- Phone endpoint -----------------------------------------------------
  // Attaches handlers to a WebSocket-like object. Returns a controller so tests
  // can feed messages / disconnect deterministically; the real ws path drives
  // the same internal handlers via 'message' / 'close' events.
  function connectPhone(ws) {
    let phoneId = null;
    let chain = Promise.resolve();
    const enqueue = (fn) => {
      const next = chain.then(fn).catch(() => {});
      chain = next;
      return next;
    };

    async function handleRaw(raw) {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'register' && phoneId === null) {
        // The phone supplies its own persistent id (localStorage) so a reconnect
        // re-attaches to the same record — keeping its slot — instead of
        // appearing as a brand-new phone.
        phoneId = String(msg.phoneId ?? '').trim() || randId();
        const old = phoneSockets.get(phoneId);
        if (old && old !== ws) {                 // a stale socket for this id
          try { old.close(); } catch { /* ignore */ }
        }
        phoneSockets.set(phoneId, ws);
        const name = String(msg.name ?? '').trim();
        const kind = ['camera', 'screen', 'audio'].includes(msg.kind) ? msg.kind : 'camera';
        let p = state.phones.get(phoneId);
        if (p) {                                 // reconnect: revive the existing record
          p.connected = true;
          p.kind = kind;
          if (name) p.name = name;
        } else {
          p = makePhone(phoneId, name || `Phone ${phoneId}`, kind);
          state.phones.set(phoneId, p);
          // Restore a persisted assignment (e.g. after a control-service restart),
          // as long as the camera still exists and isn't already taken.
          const saved = assignments[phoneId];
          if (saved && saved.slot && state.cameraIds().includes(saved.slot)
              && state.slotOwner(saved.slot) === null) {
            p.slot = saved.slot;
          }
        }
        persistAssignments();
        wsSend(ws, { type: 'registered', phoneId, recording: state.recording });
        if (p.slot) {                            // restore the armed state on the phone
          wsSend(ws, assignedMsg(p.slot));
          if (state.recording || state.previewing) {   // rejoin an in-progress preview/recording
            wsSend(ws, publishCmd(p.slot));
          }
        }
        broadcastState();
      } else if (phoneId !== null && msg.type === 'status') {
        const p = state.phones.get(phoneId);
        if (p) {
          p.publishing = Boolean(msg.publishing);
          const b = msg.battery;
          p.battery = b && typeof b === 'object' && !Array.isArray(b) ? b : null;
          broadcastState();
        }
      }
    }

    async function handleClose() {
      // Keep the phone in the roster (marked offline) so its slot is held for
      // when it reconnects. Guard against a newer socket having taken over.
      if (phoneId !== null && phoneSockets.get(phoneId) === ws) {
        phoneSockets.delete(phoneId);
        const p = state.phones.get(phoneId);
        if (p) {
          p.connected = false;
          p.publishing = false;
        }
        broadcastState();
      }
    }

    ws.on('message', (data) => enqueue(() => handleRaw(data)));
    ws.on('close', () => enqueue(handleClose));
    ws.on('error', () => {});

    return {
      feed: (msg) => enqueue(() => handleRaw(Buffer.from(JSON.stringify(msg)))),
      disconnect: () => enqueue(handleClose),
    };
  }

  // ----- Operator endpoint --------------------------------------------------
  async function handleOperatorMessage(msg) {
    const t = msg.type;

    // ---- camera management ----
    if (t === 'addCamera') {
      const label = String(msg.label ?? '').trim() || `Camera ${state.cameras.length + 1}`;
      const camId = state.nextCameraId();
      state.cameras.push(makeCamera(camId, label));
      await mtx.addPath(camId);
      persistCameras();
      broadcastState();
    } else if (t === 'addAudioSource') {
      const n = state.cameras.filter((c) => c.kind === 'audio').length + 1;
      const label = String(msg.label ?? '').trim() || `Mic ${n}`;
      const id = state.nextAudioId();
      const link = msg.link && state.cameraIds().includes(msg.link) ? msg.link : null;
      state.cameras.push(makeCamera(id, label, null, 'audio', link));
      await mtx.addPath(id);
      persistCameras();
      broadcastState();
    } else if (t === 'linkAudio') {
      const c = state.cameras.find((x) => x.id === msg.id && x.kind === 'audio');
      if (c) {
        c.link = msg.link && state.cameraIds().includes(msg.link) ? msg.link : null;
        persistCameras();
        broadcastState();
      }
    } else if (t === 'renameCamera') {
      const cid = msg.id;
      const label = String(msg.label ?? '').trim();
      if (label) {
        for (const c of state.cameras) {
          if (c.id === cid) c.label = label;
        }
        persistCameras();
        // let an assigned phone update its displayed label
        const owner = state.slotOwner(cid);
        if (owner) sendPhone(owner, assignedMsg(cid));
        broadcastState();
      }
    } else if (t === 'removeCamera') {
      const cid = msg.id;
      if (state.cameraIds().includes(cid)) {
        state.cameras = state.cameras.filter((c) => c.id !== cid);
        for (const p of state.phones.values()) {
          if (p.slot === cid) {
            p.slot = null;
            sendPhone(p.id, assignedMsg(null));
          }
        }
        if (state.recording) await mtx.setRecord(cid, false);
        await mtx.deletePath(cid);
        persistCameras();
        persistAssignments();
        broadcastState();
      }

    // ---- bitrate settings ----
    } else if (t === 'setGlobalBitrate') {
      const b = clampBitrate(msg.bitrate);
      if (b !== null) {
        state.globalBitrate = b;
        saveSettings({ globalBitrate: b });
        broadcastBitrates();           // phones on a camera without an override adjust live
        broadcastState();
      }
    } else if (t === 'setCameraBitrate') {
      const cam = state.cameras.find((c) => c.id === msg.id);
      if (cam) {
        // null / missing clears the override (revert to global); else clamp.
        cam.bitrate = msg.bitrate === null || msg.bitrate === undefined ? null : clampBitrate(msg.bitrate);
        persistCameras();
        const owner = state.slotOwner(cam.id);
        if (owner) sendPhone(owner, { type: 'bitrate', bitrate: state.effectiveBitrate(cam.id) });
        broadcastState();
      }

    // ---- slot assignment ----
    } else if (t === 'assign') {
      const pid = msg.phoneId;
      const slot = msg.slot;
      if (state.phones.has(pid) && state.cameraIds().includes(slot)) {
        for (const p of state.phones.values()) {   // one phone per slot: evict current holder
          if (p.slot === slot && p.id !== pid) {
            p.slot = null;
            sendPhone(p.id, assignedMsg(null));
          }
        }
        state.phones.get(pid).slot = slot;
        sendPhone(pid, assignedMsg(slot));
        // If preview/recording is live, the newly-assigned phone should start
        // publishing immediately — without the operator re-pressing Start Preview.
        // (The evicted prior holder self-stops on its assigned:null above.)
        if (state.previewing || state.recording) {
          sendPhone(pid, publishCmd(slot));
        }
        persistAssignments();
        broadcastState();
      }
    } else if (t === 'unassign') {
      const pid = msg.phoneId;
      if (state.phones.has(pid)) {
        state.phones.get(pid).slot = null;
        sendPhone(pid, assignedMsg(null));
        persistAssignments();
        broadcastState();
      }
    } else if (t === 'removePhone') {
      // Only an offline phone can be dropped from the roster; a connected phone
      // is managed via unassign so we don't strand its open socket.
      const pid = msg.phoneId;
      const p = state.phones.get(pid);
      if (p && !p.connected) {
        state.phones.delete(pid);
        delete assignments[pid];               // forget it entirely (don't restore on a future connect)
        saveAssignments(assignments);
        broadcastState();
      }

    // ---- preview / record ----
    } else if (t === 'startPreview') {
      const scope = msg.phoneId ?? null;
      state.previewing = true;                    // persists, so later assignments auto-publish
      for (const p of state.phones.values()) {
        if (p.slot && (scope === null || p.id === scope)) {
          sendPhone(p.id, publishCmd(p.slot));
        }
      }
      broadcastState();
    } else if (t === 'stopPreview') {
      const scope = msg.phoneId ?? null;
      if (scope === null) state.previewing = false;
      for (const p of state.phones.values()) {
        if (scope === null || p.id === scope) {
          sendPhone(p.id, { type: 'command', action: 'stop' });
        }
      }
      broadcastState();
    } else if (t === 'startRecording') {
      if (state.recording) return;                // already recording — don't reset the session
      const ready = await mtx.readyPaths();
      const cams = [...new Set(
        [...state.phones.values()].filter((p) => p.slot && ready[p.slot]).map((p) => p.slot),
      )].sort();
      if (!cams.length) return;
      state.cameraRecordStarted = {};
      for (const cam of cams) {
        await mtx.setRecord(cam, true);
        state.cameraRecordStarted[cam] = now();   // ~synchronized; per-cam for post alignment
      }
      state.recording = true;
      state.recordingStartedAt = Math.min(...Object.values(state.cameraRecordStarted));
      state.sessionId = randId();
      state.sessionName = String(msg.name ?? '').trim() || null;
      state.switches = [];
      // Optional opening take so the program starts on a chosen camera (no
      // black pre-roll). Only valid if that camera is in the recording set.
      const initialCam = msg.initialCam;
      if (initialCam && Object.prototype.hasOwnProperty.call(state.cameraRecordStarted, initialCam)) {
        const ts = now();
        state.switches.push({
          t: ts, offset: round3(ts - state.recordingStartedAt), camId: initialCam, label: state.labelFor(initialCam),
        });
      }
      for (const pid of [...phoneSockets.keys()]) {
        sendPhone(pid, { type: 'recording', on: true });
      }
      broadcastState();
    } else if (t === 'switch') {
      const cam = msg.camId;
      // Only a camera actually being recorded this session can be taken — taking
      // a camera with no footage would put a useless cut point in the log. Audio
      // sources are never a program angle.
      if (state.recording && !state.isAudio(cam) && Object.prototype.hasOwnProperty.call(state.cameraRecordStarted, cam)) {
        // ignore a repeat take of the camera already on program — keeps the log clean
        const last = state.switches[state.switches.length - 1];
        if (!last || last.camId !== cam) {
          const ts = now();
          state.switches.push({
            t: ts,
            offset: round3(ts - (state.recordingStartedAt || ts)),
            camId: cam,
            label: state.labelFor(cam),
          });
          broadcastState();
        }
      }
    } else if (t === 'stopRecording') {
      await stopRecording();
    }
  }

  function connectOperator(ws) {
    operators.add(ws);
    wsSend(ws, { type: 'state', ...state.snapshot() });
    let chain = Promise.resolve();
    const enqueue = (fn) => {
      const next = chain.then(fn).catch(() => {});
      chain = next;
      return next;
    };

    ws.on('message', (data) => enqueue(async () => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      await handleOperatorMessage(msg);
    }));
    ws.on('close', () => operators.delete(ws));
    ws.on('error', () => {});

    return {
      feed: (msg) => enqueue(() => handleOperatorMessage(msg)),
      disconnect: () => { operators.delete(ws); },
    };
  }

  // ----- Reconcile with MediaMTX --------------------------------------------
  async function reconcileOnce() {
    const ready = await mtx.readyPaths();
    for (const c of state.cameras) {              // survive a MediaMTX restart
      if (!(c.id in ready)) await mtx.addPath(c.id);
    }
    let changed = false;
    for (const p of state.phones.values()) {
      const want = Boolean(p.slot && ready[p.slot]);
      if (p.publishing !== want) {
        p.publishing = want;
        changed = true;
      }
    }

    // Grow the recording set: a camera that goes live *during* a recording
    // (a late-joining phone, or one reassigned mid-take) starts recording with
    // its own start stamp and becomes takeable. Without this, the set frozen at
    // Record time would silently drop such cameras from both capture and the
    // switch log. recordingStartedAt stays the session start (min is unchanged
    // since a late stamp is necessarily later).
    if (state.recording) {
      for (const c of state.cameras) {
        if (ready[c.id] && !Object.prototype.hasOwnProperty.call(state.cameraRecordStarted, c.id)) {
          await mtx.setRecord(c.id, true);
          state.cameraRecordStarted[c.id] = now();
          changed = true;
        }
      }
    }

    if (changed) broadcastState();

    // Auto-clear a recording left running after every publisher has dropped.
    if (state.recording && ![...state.phones.values()].some((p) => p.publishing)) {
      if (emptySince === null) {
        emptySince = monotonic();
      } else if (monotonic() - emptySince >= autoStopGraceS) {
        await stopRecording();
        emptySince = null;
      }
    } else {
      emptySince = null;
    }
  }

  async function startup() {
    state.cameras = loadCameras();
    for (const c of state.cameras) {
      await mtx.addPath(c.id);
    }
  }

  return {
    state,
    operators,
    phoneSockets,
    connectPhone,
    connectOperator,
    handleOperatorMessage,
    stopRecording,
    reconcileOnce,
    startup,
    broadcastState,
  };
}

// ----- HTTP API (read-only; proxied to the dashboard under /api) ------------
function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

function handleHttp(svc, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      cameras: svc.state.cameras.length,
      phones: svc.state.phones.size,
      recording: svc.state.recording,
    });
    return;
  }
  if (req.method === 'GET' && path === '/api/recordings') {
    sendJson(res, 200, { cameras: recordingsStore.listRecordings() });
    return;
  }
  if (req.method === 'GET' && path === '/api/sessions') {
    // The raw switch-log array — also what the dashboard offers as switches.json.
    sendJson(res, 200, switchesStore.loadSessions());
    return;
  }
  if (req.method === 'DELETE' && path === '/api/sessions') {
    const id = url.searchParams.get('id') ?? '';
    const ok = switchesStore.deleteSession(id);
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
    return;
  }
  if (req.method === 'GET' && path === '/api/preflight') {
    sendJson(res, 200, recordingsStore.preflight());
    return;
  }
  // ----- Session export (render the switch log to one MP4) -----
  if ((req.method === 'GET' || req.method === 'HEAD') && path === '/api/export/download') {
    const id = url.searchParams.get('id') ?? '';
    if (!exportsStore.serveExport(id, req, res)) sendJson(res, 404, { error: 'not found' });
    return;
  }
  if (req.method === 'POST' && path === '/api/export') {
    const id = url.searchParams.get('id') ?? '';
    const session = switchesStore.loadSessions().find((s) => s.sessionId === id);
    if (!session) { sendJson(res, 404, { error: 'session not found' }); return; }
    try {
      const crossfade = ['1', 'true', 'yes'].includes((url.searchParams.get('crossfade') || '').toLowerCase());
      const fade = parseFloat(url.searchParams.get('fade')) || 0.5;
      const job = exportsStore.startExport(session, { crossfade, fade });
      sendJson(res, 202, { status: job.status, progress: job.progress, error: job.error || null });
    } catch (e) {
      sendJson(res, 400, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'GET' && path === '/api/export') {
    const id = url.searchParams.get('id');
    if (id) {
      const job = exportsStore.getJob(id);
      sendJson(res, 200, job ? { status: job.status, progress: job.progress, error: job.error || null, ready: job.status === 'done' } : { status: 'none' });
    } else {
      sendJson(res, 200, exportsStore.getAllJobs());
    }
    return;
  }
  if (req.method === 'DELETE' && path === '/api/recordings/download') {
    const cam = url.searchParams.get('cam') ?? '';
    const name = url.searchParams.get('name') ?? '';
    const ok = recordingsStore.deleteRecording(cam, name);
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && path === '/api/recordings/download') {
    const cam = url.searchParams.get('cam') ?? '';
    const name = url.searchParams.get('name') ?? '';
    const file = recordingsStore.resolveRecording(cam, name);
    if (file === null) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const total = statSync(file).size;
    // Served inline (not attachment) so a <video> can play it; the dashboard's
    // download links use the `download` attribute, so they still download.
    // Accept-Ranges + 206 lets the player seek (and Safari requires range).
    const base = {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'content-disposition': `inline; filename="${cam}_${name}"`,
    };
    const range = req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] === '' ? null : parseInt(m[1], 10);
      let end = m[2] === '' ? null : parseInt(m[2], 10);
      if (start === null) { start = Math.max(0, total - (end ?? 0)); end = total - 1; }   // bytes=-N suffix
      else if (end === null || end >= total) { end = total - 1; }
      if (start > end || start >= total) {
        res.writeHead(416, { 'content-range': `bytes */${total}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...base, 'content-length': total });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

// ----- Main: wire the real HTTP + WebSocket server --------------------------
export async function runControl() {
  const { WebSocketServer } = await import('ws');
  const mtx = new MediaMTX();
  const svc = createService(mtx);
  await svc.startup();

  const server = createServer((req, res) => handleHttp(svc, req, res));
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url || '').split('?')[0];
    if (path === '/ws/phone') {
      wss.handleUpgrade(req, socket, head, (ws) => svc.connectPhone(ws));
    } else if (path === '/ws/operator') {
      wss.handleUpgrade(req, socket, head, (ws) => svc.connectOperator(ws));
    } else {
      socket.destroy();
    }
  });

  const interval = setInterval(() => { void svc.reconcileOnce(); }, 2000);
  const shutdown = () => {
    clearInterval(interval);
    mtx.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const port = Number(process.env.MULTICAM_CONTROL_PORT) || 9000;
  server.listen(port, '127.0.0.1', () => {
    console.log(`Control service on http://127.0.0.1:${port}  (ws: /ws/phone, /ws/operator)`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runControl().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
