// In-memory session state for the control service.
//
// Cameras are dynamic (operator can add/rename/remove); the canonical list is
// persisted to disk by cameras.mjs. A "slot" is a camera id (e.g. cam1) — the
// MediaMTX path a phone publishes to.

// A source (MediaMTX path the device publishes to). Two kinds:
//   kind 'video' — a camera/screen; a takeable program angle with a grid tile.
//   kind 'audio' — an external mic; recorded as its own clip, NOT takeable and no
//                  video tile. `link` is the camera id it's routed to in the
//                  export (or null = global/unlinked).
//   id     MediaMTX path ("cam1" for video, "mic1" for audio)
//   label  display name
//   bitrate per-source publish-bitrate override (bps) or null = global default
export function makeCamera(id, label, bitrate = null, kind = 'video', link = null) {
  return {
    id, label,
    bitrate: typeof bitrate === 'number' ? bitrate : null,
    kind: kind === 'audio' ? 'audio' : 'video',
    link: kind === 'audio' ? (link || null) : null,
  };
}

// A phone:
//   id          persistent, supplied by the phone (localStorage)
//   name
//   slot        camera id, or null (unassigned)
//   kind        capture kind it reports: 'camera' | 'screen' | 'audio'
//   publishing  is its slot live in MediaMTX
//   connected   WebSocket currently open (survives reconnects)
//   battery     {level: 0-1, charging: bool} where reported (not iOS), else null
export function makePhone(id, name, kind = 'camera') {
  return { id, name, slot: null, kind, publishing: false, connected: true, battery: null };
}

// Default global publish bitrate (bps); the operator can change it and override
// it per camera. Kept here so state has a sane value before settings load.
const DEFAULT_BITRATE = 8_000_000;

export class SessionState {
  constructor() {
    this.cameras = [];                 // Camera[]
    this.globalBitrate = DEFAULT_BITRATE;   // operator-tunable default for every camera
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

  // The publish bitrate a phone on this slot should use: the camera's own
  // override if set, otherwise the global default.
  effectiveBitrate(slot) {
    const c = this.cameras.find((x) => x.id === slot);
    if (c && typeof c.bitrate === 'number') return c.bitrate;
    return this.globalBitrate;
  }

  nextCameraId() {
    const existing = new Set(this.cameraIds());
    let n = 1;
    while (existing.has(`cam${n}`)) n += 1;
    return `cam${n}`;
  }

  nextAudioId() {
    const existing = new Set(this.cameraIds());
    let n = 1;
    while (existing.has(`mic${n}`)) n += 1;
    return `mic${n}`;
  }

  isAudio(id) {
    const c = this.cameras.find((x) => x.id === id);
    return !!c && c.kind === 'audio';
  }

  snapshot() {
    return {
      cameras: this.cameras.map((c) => ({ id: c.id, label: c.label, bitrate: c.bitrate ?? null, kind: c.kind || 'video', link: c.link ?? null })),
      globalBitrate: this.globalBitrate,
      phones: [...this.phones.values()].map((p) => ({
        id: p.id,
        name: p.name,
        slot: p.slot,
        kind: p.kind || 'camera',
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
