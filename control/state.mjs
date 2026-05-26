// In-memory session state for the control service.
//
// Cameras are dynamic (operator can add/rename/remove); the canonical list is
// persisted to disk by cameras.mjs. A "slot" is a camera id (e.g. cam1) — the
// MediaMTX path a phone publishes to.

// A camera: { id (MediaMTX path, e.g. "cam1"), label (display name, e.g. "Wide") }.
export function makeCamera(id, label) {
  return { id, label };
}

// A phone:
//   id          persistent, supplied by the phone (localStorage)
//   name
//   slot        camera id, or null (unassigned)
//   publishing  is its slot live in MediaMTX
//   connected   WebSocket currently open (survives reconnects)
//   battery     {level: 0-1, charging: bool} where reported (not iOS), else null
export function makePhone(id, name) {
  return { id, name, slot: null, publishing: false, connected: true, battery: null };
}

export class SessionState {
  constructor() {
    this.cameras = [];                 // Camera[]
    this.phones = new Map();           // id -> Phone
    this.previewing = false;           // operator has started preview; new assignments auto-publish
    this.recording = false;
    this.recordingStartedAt = null;
    this.sessionId = null;
    this.sessionName = null;           // optional operator-supplied label for the session
    this.cameraRecordStarted = {};     // camId -> epoch (when record enabled)
    this.switches = [];                // [{t, offset, camId, label}] for the live session
  }

  cameraIds() {
    return this.cameras.map((c) => c.id);
  }

  slotOwner(slot) {
    for (const p of this.phones.values()) {
      if (p.slot === slot) return p.id;
    }
    return null;
  }

  labelFor(slot) {
    for (const c of this.cameras) {
      if (c.id === slot) return c.label;
    }
    return null;
  }

  nextCameraId() {
    const existing = new Set(this.cameraIds());
    let n = 1;
    while (existing.has(`cam${n}`)) n += 1;
    return `cam${n}`;
  }

  snapshot() {
    return {
      cameras: this.cameras.map((c) => ({ id: c.id, label: c.label })),
      phones: [...this.phones.values()].map((p) => ({
        id: p.id,
        name: p.name,
        slot: p.slot,
        publishing: p.publishing,
        connected: p.connected,
        battery: p.battery,
      })),
      slots: Object.fromEntries(this.cameras.map((c) => [c.id, this.slotOwner(c.id)])),
      previewing: this.previewing,
      recording: this.recording,
      recordingStartedAt: this.recordingStartedAt,
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      cameraRecordStartedAt: this.cameraRecordStarted,
      switches: this.switches,
    };
  }
}
