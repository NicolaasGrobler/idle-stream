// Parity tests for the Node control service. These drive the real handlers with
// a fake WebSocket and a stubbed MediaMTX — the same shape the throwaway Python
// tests used, now committed. They lock in the subtle behaviors: switch-log flow,
// persistent-id reconnect (slot survives), auto-clear grace, battery-in-status,
// and recordings traversal rejection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createService } from '../index.mjs';
import { resolveRecording } from '../recordings.mjs';

// A WebSocket-like double: captures everything the service sends, and emits
// 'close' when the service closes it (so a stale-socket takeover is exercised).
class FakeWS extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = false;
    this.on('error', () => {});   // service attaches one too; keep node quiet
  }

  send(data, cb) {
    this.sent.push(JSON.parse(data));
    if (cb) cb();
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      queueMicrotask(() => this.emit('close'));
    }
  }

  typed(type) {
    return this.sent.filter((m) => m.type === type);
  }

  last(type) {
    const matches = this.typed(type);
    return matches[matches.length - 1];
  }
}

// Stubbed MediaMTX control API. `ready` decides which paths report a live
// publisher; record toggles and path adds/deletes are recorded.
class StubMTX {
  constructor(ready = {}) {
    this.ready = ready;
    this.records = {};
    this.paths = new Set();
    this.calls = [];
  }

  async setRecord(path, on) {
    this.records[path] = on;
    this.calls.push(['setRecord', path, on]);
  }

  async addPath(name) {
    this.paths.add(name);
  }

  async deletePath(name) {
    this.paths.delete(name);
  }

  async readyPaths() {
    return { ...this.ready };
  }

  async close() {}
}

// Build a service with three cameras already present (skipping startup so we
// never touch data/). Persistence is captured in-memory.
function makeSvc(mtx, opts = {}) {
  const sessions = [];
  const svc = createService(mtx, {
    saveCameras: () => {},
    appendSession: (s) => sessions.push(s),
    ...opts,
  });
  svc.state.cameras = [
    { id: 'cam1', label: 'Wide' },
    { id: 'cam2', label: 'Center' },
    { id: 'cam3', label: 'Side' },
  ];
  svc.sessions = sessions;
  return svc;
}

// A monotonically increasing wall clock, so timestamps/offsets are deterministic.
function fakeClock(start = 1000) {
  let t = start;
  return { now: () => (t += 1), set: (v) => { t = v; }, peek: () => t };
}

test('switch-log flow: record stamps cameras, takes log offsets, stop finalizes', async () => {
  const clock = fakeClock(1000);
  const mtx = new StubMTX({ cam1: true, cam2: true });   // cam1+cam2 live, cam3 not
  const svc = makeSvc(mtx, { now: clock.now });

  // Two phones register and get assigned to cam1 / cam2.
  const opWs = new FakeWS();
  const op = svc.connectOperator(opWs);
  const aWs = new FakeWS();
  const a = svc.connectPhone(aWs);
  const bWs = new FakeWS();
  const b = svc.connectPhone(bWs);
  await a.feed({ type: 'register', phoneId: 'pa', name: 'A' });
  await b.feed({ type: 'register', phoneId: 'pb', name: 'B' });
  await op.feed({ type: 'assign', phoneId: 'pa', slot: 'cam1' });
  await op.feed({ type: 'assign', phoneId: 'pb', slot: 'cam2' });

  // Record: only cam1+cam2 are live, so cam3 is excluded.
  await op.feed({ type: 'startRecording' });
  assert.equal(svc.state.recording, true);
  assert.deepEqual(Object.keys(svc.state.cameraRecordStarted).sort(), ['cam1', 'cam2']);
  assert.equal(svc.state.recordingStartedAt, Math.min(...Object.values(svc.state.cameraRecordStarted)));
  assert.equal(mtx.records.cam1, true);
  assert.equal(mtx.records.cam2, true);
  assert.equal(mtx.records.cam3, undefined);              // never armed — wasn't live
  // both phones told recording is on
  assert.ok(aWs.last('recording').on === true);
  assert.ok(bWs.last('recording').on === true);

  // Takes: cam1, cam1 (dup ignored), cam2.
  await op.feed({ type: 'switch', camId: 'cam1' });
  await op.feed({ type: 'switch', camId: 'cam1' });        // consecutive duplicate -> skipped
  await op.feed({ type: 'switch', camId: 'cam2' });
  await op.feed({ type: 'switch', camId: 'nope' });        // unknown camera -> ignored
  assert.equal(svc.state.switches.length, 2);
  assert.deepEqual(svc.state.switches.map((s) => s.camId), ['cam1', 'cam2']);
  assert.equal(svc.state.switches[0].label, 'Wide');
  assert.equal(svc.state.switches[1].label, 'Center');
  for (const s of svc.state.switches) {
    assert.equal(s.offset, Math.round((s.t - svc.state.recordingStartedAt) * 1000) / 1000);
    assert.ok(s.offset >= 0);
  }

  // Stop: session is finalized and live state cleared.
  await op.feed({ type: 'stopRecording' });
  assert.equal(svc.state.recording, false);
  assert.equal(svc.state.sessionId, null);
  assert.deepEqual(svc.state.switches, []);
  assert.equal(mtx.records.cam1, false);
  assert.equal(mtx.records.cam2, false);

  assert.equal(svc.sessions.length, 1);
  const sess = svc.sessions[0];
  assert.equal(sess.switches.length, 2);
  assert.equal(sess.cameras.length, 2);
  assert.deepEqual(sess.cameras.map((c) => c.id).sort(), ['cam1', 'cam2']);
  assert.ok(typeof sess.durationSec === 'number' && sess.durationSec >= 0);
  assert.ok(sess.startedAtIso.endsWith('+00:00'));
  assert.ok(sess.sessionId);
});

test('startRecording is ignored when already recording (no session reset)', async () => {
  const mtx = new StubMTX({ cam1: true });
  const svc = makeSvc(mtx);
  const op = svc.connectOperator(new FakeWS());
  const ph = svc.connectPhone(new FakeWS());
  await ph.feed({ type: 'register', phoneId: 'pa', name: 'A' });
  await op.feed({ type: 'assign', phoneId: 'pa', slot: 'cam1' });

  await op.feed({ type: 'startRecording' });
  const sid = svc.state.sessionId;
  const startedAt = svc.state.recordingStartedAt;
  await op.feed({ type: 'startRecording' });               // second press is a no-op
  assert.equal(svc.state.sessionId, sid);
  assert.equal(svc.state.recordingStartedAt, startedAt);
});

test('persistent-id reconnect: slot survives, recording resumes, stale socket closed', async () => {
  const mtx = new StubMTX({ cam1: true });
  const svc = makeSvc(mtx);
  const op = svc.connectOperator(new FakeWS());

  const ws1 = new FakeWS();
  const p1 = svc.connectPhone(ws1);
  await p1.feed({ type: 'register', phoneId: 'persist-1', name: 'Cam A' });
  await op.feed({ type: 'assign', phoneId: 'persist-1', slot: 'cam1' });
  await op.feed({ type: 'startRecording' });
  assert.equal(svc.state.recording, true);

  // Phone drops: kept in roster, marked offline, slot held.
  await p1.disconnect();
  const offline = svc.state.phones.get('persist-1');
  assert.equal(offline.connected, false);
  assert.equal(offline.publishing, false);
  assert.equal(offline.slot, 'cam1');                      // slot retained across the drop

  // Reconnect with the same id: revives the record, restores the slot, and —
  // because a recording is in progress — re-issues the publish command.
  const ws2 = new FakeWS();
  const p2 = svc.connectPhone(ws2);
  await p2.feed({ type: 'register', phoneId: 'persist-1', name: 'Cam A' });
  const revived = svc.state.phones.get('persist-1');
  assert.equal(revived.connected, true);
  assert.equal(revived.slot, 'cam1');
  assert.equal(svc.state.phones.size, 1);                  // no duplicate phone created
  assert.equal(ws2.last('registered').recording, true);
  assert.equal(ws2.last('assigned').slot, 'cam1');
  assert.deepEqual(ws2.last('command'), { type: 'command', action: 'publish', slot: 'cam1' });

  // A *third* socket claiming the same id closes the previous one (ws2).
  const ws3 = new FakeWS();
  const p3 = svc.connectPhone(ws3);
  await p3.feed({ type: 'register', phoneId: 'persist-1', name: 'Cam A' });
  assert.equal(ws2.closed, true);
  assert.equal(svc.phoneSockets.get('persist-1'), ws3);

  // The (now stale) ws2 firing its close handler must NOT evict the live ws3.
  await new Promise((r) => setTimeout(r, 5));              // let queued 'close' settle
  assert.equal(svc.phoneSockets.get('persist-1'), ws3);
  assert.equal(svc.state.phones.get('persist-1').connected, true);
});

test('removePhone only drops an offline phone', async () => {
  const mtx = new StubMTX();
  const svc = makeSvc(mtx);
  const op = svc.connectOperator(new FakeWS());
  const ph = svc.connectPhone(new FakeWS());
  await ph.feed({ type: 'register', phoneId: 'pa', name: 'A' });

  await op.feed({ type: 'removePhone', phoneId: 'pa' });   // still connected -> ignored
  assert.equal(svc.state.phones.has('pa'), true);

  await ph.disconnect();
  await op.feed({ type: 'removePhone', phoneId: 'pa' });   // now offline -> removed
  assert.equal(svc.state.phones.has('pa'), false);
});

test('assign evicts the prior holder of a slot (one phone per slot)', async () => {
  const mtx = new StubMTX();
  const svc = makeSvc(mtx);
  const op = svc.connectOperator(new FakeWS());
  const aWs = new FakeWS();
  const a = svc.connectPhone(aWs);
  const b = svc.connectPhone(new FakeWS());
  await a.feed({ type: 'register', phoneId: 'pa', name: 'A' });
  await b.feed({ type: 'register', phoneId: 'pb', name: 'B' });

  await op.feed({ type: 'assign', phoneId: 'pa', slot: 'cam1' });
  await op.feed({ type: 'assign', phoneId: 'pb', slot: 'cam1' });   // evicts pa
  assert.equal(svc.state.phones.get('pa').slot, null);
  assert.equal(svc.state.phones.get('pb').slot, 'cam1');
  assert.equal(aWs.last('assigned').slot, null);                    // pa told it was unassigned
});

test('battery is carried through status messages (and only dicts accepted)', async () => {
  const mtx = new StubMTX();
  const svc = makeSvc(mtx);
  svc.connectOperator(new FakeWS());
  const ph = svc.connectPhone(new FakeWS());
  await ph.feed({ type: 'register', phoneId: 'pa', name: 'A' });

  await ph.feed({ type: 'status', publishing: true, battery: { level: 0.42, charging: false } });
  let p = svc.state.phones.get('pa');
  assert.equal(p.publishing, true);
  assert.deepEqual(p.battery, { level: 0.42, charging: false });

  await ph.feed({ type: 'status', publishing: false, battery: 'nope' });   // non-dict -> null
  p = svc.state.phones.get('pa');
  assert.equal(p.publishing, false);
  assert.equal(p.battery, null);
});

test('auto-clear: stops only after the grace window with no live publisher; a blip resets it', async () => {
  const clock = fakeClock(0);
  const mono = { t: 0 };
  const mtx = new StubMTX({ cam1: true });
  const sessions = [];
  const svc = createService(mtx, {
    saveCameras: () => {},
    appendSession: (s) => sessions.push(s),
    autoStopGraceS: 30,
    monotonic: () => mono.t,
    now: clock.now,
  });
  svc.state.cameras = [{ id: 'cam1', label: 'Wide' }];

  const op = svc.connectOperator(new FakeWS());
  const ph = svc.connectPhone(new FakeWS());
  await ph.feed({ type: 'register', phoneId: 'pa', name: 'A' });
  await op.feed({ type: 'assign', phoneId: 'pa', slot: 'cam1' });
  await op.feed({ type: 'startRecording' });
  assert.equal(svc.state.recording, true);

  // Publisher drops.
  mtx.ready = {};
  mono.t = 100;
  await svc.reconcileOnce();                  // arms the empty timer; no stop yet
  assert.equal(svc.state.recording, true);
  mono.t = 120;
  await svc.reconcileOnce();                  // 20s < 30s grace -> still recording
  assert.equal(svc.state.recording, true);

  // Blip: publisher returns within the window -> timer resets.
  mtx.ready = { cam1: true };
  mono.t = 125;
  await svc.reconcileOnce();
  assert.equal(svc.state.recording, true);

  // Drops again; the window must restart from here.
  mtx.ready = {};
  mono.t = 140;
  await svc.reconcileOnce();                  // re-arms at 140
  assert.equal(svc.state.recording, true);
  mono.t = 165;
  await svc.reconcileOnce();                  // 25s < 30s -> still recording
  assert.equal(svc.state.recording, true);
  mono.t = 175;
  await svc.reconcileOnce();                  // 35s >= 30s -> auto-stop + finalize
  assert.equal(svc.state.recording, false);
  assert.equal(sessions.length, 1);
});

test('reconcile re-adds missing MediaMTX paths and syncs publishing', async () => {
  const mtx = new StubMTX({});               // nothing live, no paths
  const svc = makeSvc(mtx);
  const op = svc.connectOperator(new FakeWS());
  const ph = svc.connectPhone(new FakeWS());
  await ph.feed({ type: 'register', phoneId: 'pa', name: 'A' });
  await op.feed({ type: 'assign', phoneId: 'pa', slot: 'cam1' });

  await svc.reconcileOnce();
  assert.ok(mtx.paths.has('cam1'));          // missing path re-added
  assert.equal(svc.state.phones.get('pa').publishing, false);

  mtx.ready = { cam1: true };
  await svc.reconcileOnce();
  assert.equal(svc.state.phones.get('pa').publishing, true);   // publishing synced from ready
});

test('removeCamera unassigns its phone and deletes the MediaMTX path', async () => {
  const mtx = new StubMTX();
  const svc = makeSvc(mtx);
  mtx.paths.add('cam1');
  const op = svc.connectOperator(new FakeWS());
  const aWs = new FakeWS();
  const a = svc.connectPhone(aWs);
  await a.feed({ type: 'register', phoneId: 'pa', name: 'A' });
  await op.feed({ type: 'assign', phoneId: 'pa', slot: 'cam1' });

  await op.feed({ type: 'removeCamera', id: 'cam1' });
  assert.equal(svc.state.cameraIds().includes('cam1'), false);
  assert.equal(svc.state.phones.get('pa').slot, null);
  assert.equal(aWs.last('assigned').slot, null);
  assert.equal(mtx.paths.has('cam1'), false);
});

test('preview follows assignment: a phone assigned while previewing auto-publishes', async () => {
  const mtx = new StubMTX();
  const svc = makeSvc(mtx);
  const op = svc.connectOperator(new FakeWS());
  const aWs = new FakeWS();
  const a = svc.connectPhone(aWs);
  await a.feed({ type: 'register', phoneId: 'pa', name: 'A' });

  // Before preview: assigning does NOT command publish.
  await op.feed({ type: 'assign', phoneId: 'pa', slot: 'cam1' });
  assert.equal(aWs.typed('command').length, 0);

  // Start preview: pa (already assigned) is told to publish, and the flag sticks.
  await op.feed({ type: 'startPreview' });
  assert.equal(svc.state.previewing, true);
  assert.deepEqual(aWs.last('command'), { type: 'command', action: 'publish', slot: 'cam1' });

  // A phone assigned AFTER preview started auto-publishes — no second Start Preview.
  const bWs = new FakeWS();
  const b = svc.connectPhone(bWs);
  await b.feed({ type: 'register', phoneId: 'pb', name: 'B' });
  await op.feed({ type: 'assign', phoneId: 'pb', slot: 'cam2' });
  assert.deepEqual(bWs.last('command'), { type: 'command', action: 'publish', slot: 'cam2' });

  // Reassigning cam1 from pa to a third phone: the new holder publishes; pa is
  // told it's unassigned (the phone self-stops on assigned:null).
  const cWs = new FakeWS();
  const c = svc.connectPhone(cWs);
  await c.feed({ type: 'register', phoneId: 'pc', name: 'C' });
  await op.feed({ type: 'assign', phoneId: 'pc', slot: 'cam1' });
  assert.deepEqual(cWs.last('command'), { type: 'command', action: 'publish', slot: 'cam1' });
  assert.equal(aWs.last('assigned').slot, null);
  assert.equal(svc.state.phones.get('pa').slot, null);

  // Stop preview clears the flag and stops everyone.
  await op.feed({ type: 'stopPreview' });
  assert.equal(svc.state.previewing, false);
  assert.deepEqual(bWs.last('command'), { type: 'command', action: 'stop' });
});

test('preview resumes on reconnect (not only during recording)', async () => {
  const mtx = new StubMTX();
  const svc = makeSvc(mtx);
  const op = svc.connectOperator(new FakeWS());
  const ws1 = new FakeWS();
  const p1 = svc.connectPhone(ws1);
  await p1.feed({ type: 'register', phoneId: 'pa', name: 'A' });
  await op.feed({ type: 'assign', phoneId: 'pa', slot: 'cam1' });
  await op.feed({ type: 'startPreview' });
  await p1.disconnect();

  const ws2 = new FakeWS();
  const p2 = svc.connectPhone(ws2);
  await p2.feed({ type: 'register', phoneId: 'pa', name: 'A' });
  assert.equal(ws2.last('assigned').slot, 'cam1');
  assert.deepEqual(ws2.last('command'), { type: 'command', action: 'publish', slot: 'cam1' });
});

test('switch only logs cameras in the recording set', async () => {
  const mtx = new StubMTX({ cam1: true });          // only cam1 is live at Record
  const svc = makeSvc(mtx);
  const op = svc.connectOperator(new FakeWS());
  const ph = svc.connectPhone(new FakeWS());
  await ph.feed({ type: 'register', phoneId: 'pa', name: 'A' });
  await op.feed({ type: 'assign', phoneId: 'pa', slot: 'cam1' });
  await op.feed({ type: 'startRecording' });
  assert.deepEqual(Object.keys(svc.state.cameraRecordStarted), ['cam1']);

  await op.feed({ type: 'switch', camId: 'cam3' });  // real camera, but not recording -> ignored
  await op.feed({ type: 'switch', camId: 'cam2' });  // not recording -> ignored
  assert.equal(svc.state.switches.length, 0);
  await op.feed({ type: 'switch', camId: 'cam1' });  // recording -> logged
  assert.equal(svc.state.switches.length, 1);
  assert.equal(svc.state.switches[0].camId, 'cam1');
});

test('a camera that goes live mid-recording joins the recording set and is takeable', async () => {
  const mtx = new StubMTX({ cam1: true });          // only cam1 live at Record
  const svc = makeSvc(mtx);
  const op = svc.connectOperator(new FakeWS());
  const a = svc.connectPhone(new FakeWS());
  await a.feed({ type: 'register', phoneId: 'pa', name: 'A' });
  await op.feed({ type: 'assign', phoneId: 'pa', slot: 'cam1' });
  await op.feed({ type: 'startRecording' });
  assert.deepEqual(Object.keys(svc.state.cameraRecordStarted), ['cam1']);
  const sessionStart = svc.state.recordingStartedAt;

  // A second phone is assigned to cam2 mid-recording and goes live.
  const b = svc.connectPhone(new FakeWS());
  await b.feed({ type: 'register', phoneId: 'pb', name: 'B' });
  await op.feed({ type: 'assign', phoneId: 'pb', slot: 'cam2' });
  await op.feed({ type: 'switch', camId: 'cam2' });          // not recording yet -> ignored
  assert.equal(svc.state.switches.length, 0);

  mtx.ready = { cam1: true, cam2: true };
  await svc.reconcileOnce();                                  // cam2 now live -> joins the set
  assert.ok(Object.prototype.hasOwnProperty.call(svc.state.cameraRecordStarted, 'cam2'));
  assert.equal(mtx.records.cam2, true);
  assert.equal(svc.state.recordingStartedAt, sessionStart);  // session start unchanged

  await op.feed({ type: 'switch', camId: 'cam2' });          // now recordable -> logged
  assert.equal(svc.state.switches.length, 1);
  assert.equal(svc.state.switches[0].camId, 'cam2');
});

test('snapshot includes the previewing flag', async () => {
  const mtx = new StubMTX();
  const svc = makeSvc(mtx);
  assert.equal(svc.state.snapshot().previewing, false);
  const op = svc.connectOperator(new FakeWS());
  await op.feed({ type: 'startPreview' });
  assert.equal(svc.state.snapshot().previewing, true);
});

test('phone assignments survive a control-service restart', async () => {
  const store = {};                                   // shared on-disk assignments map
  const opts = { loadAssignments: () => store, saveAssignments: (m) => Object.assign(store, m) };
  const cams = [{ id: 'cam1', label: 'Wide' }, { id: 'cam2', label: 'Center' }];

  // First service instance: two phones assigned.
  let mtx = new StubMTX();
  let svc = createService(mtx, { saveCameras: () => {}, appendSession: () => {}, ...opts });
  svc.state.cameras = cams.map((c) => ({ ...c }));
  let op = svc.connectOperator(new FakeWS());
  await svc.connectPhone(new FakeWS()).feed({ type: 'register', phoneId: 'pa', name: 'A' });
  await svc.connectPhone(new FakeWS()).feed({ type: 'register', phoneId: 'pb', name: 'B' });
  await op.feed({ type: 'assign', phoneId: 'pa', slot: 'cam1' });
  await op.feed({ type: 'assign', phoneId: 'pb', slot: 'cam2' });
  assert.equal(store.pa.slot, 'cam1');
  assert.equal(store.pb.slot, 'cam2');

  // Simulate a restart: brand-new service, fresh state, same persisted store.
  mtx = new StubMTX();
  svc = createService(mtx, { saveCameras: () => {}, appendSession: () => {}, ...opts });
  svc.state.cameras = cams.map((c) => ({ ...c }));
  op = svc.connectOperator(new FakeWS());
  assert.equal(svc.state.phones.size, 0);             // assignments aren't phones — roster starts empty

  // Phones reconnect (as the real ones do) and are restored to their slots.
  const ws = new FakeWS();
  await svc.connectPhone(ws).feed({ type: 'register', phoneId: 'pa', name: 'A' });
  assert.equal(svc.state.phones.get('pa').slot, 'cam1');
  assert.equal(ws.last('assigned').slot, 'cam1');     // phone told its restored slot
  await svc.connectPhone(new FakeWS()).feed({ type: 'register', phoneId: 'pb', name: 'B' });
  assert.equal(svc.state.phones.get('pb').slot, 'cam2');

  // A restored slot isn't double-assigned if another phone already holds it.
  const wsDup = new FakeWS();
  await svc.connectPhone(wsDup).feed({ type: 'register', phoneId: 'pa', name: 'A dup' });
  // pa already connected with cam1; the dup register revives the same record (slot kept).
  assert.equal(svc.state.phones.get('pa').slot, 'cam1');
});

test('recordings download rejects path traversal', () => {
  // Valid single segments that don't exist still return null (no file), but the
  // point here is that traversal / separators are rejected outright.
  assert.equal(resolveRecording('..', 'x.mp4'), null);
  assert.equal(resolveRecording('cam1', '..'), null);
  assert.equal(resolveRecording('cam1/../..', 'x.mp4'), null);   // separator -> fails SAFE regex
  assert.equal(resolveRecording('cam1', '../../etc/passwd'), null);
  assert.equal(resolveRecording('cam1', 'a\\b'), null);          // backslash -> fails SAFE regex
  assert.equal(resolveRecording('', 'x.mp4'), null);
  assert.equal(resolveRecording('cam1', ''), null);
  // A clean pair that simply doesn't exist on disk also yields null (not a throw).
  assert.equal(resolveRecording('cam1', 'nonexistent-file.mp4'), null);
});
