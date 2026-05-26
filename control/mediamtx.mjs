// Thin client for the MediaMTX control API (localhost:9997).
//
// Isolated here so the recording-control mechanism can be swapped without
// touching the rest of the service. Currently recording is toggled per-path at
// runtime via the config patch endpoint.

const API = 'http://127.0.0.1:9997';
const TIMEOUT_MS = 5000;

export class MediaMTX {
  // Turn copy-only recording on/off for a path at runtime.
  async setRecord(path, on) {
    try {
      await fetch(`${API}/v3/config/paths/patch/${path}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ record: on }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      /* MediaMTX may be momentarily unreachable; reconcile re-asserts state */
    }
  }

  // Create a path (idempotent enough — ignore 'already exists').
  async addPath(name) {
    try {
      await fetch(`${API}/v3/config/paths/add/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ record: false }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      /* ignore */
    }
  }

  async deletePath(name) {
    try {
      await fetch(`${API}/v3/config/paths/delete/${name}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      /* ignore */
    }
  }

  // Map of path name -> whether a publisher is currently live.
  async readyPaths() {
    try {
      const r = await fetch(`${API}/v3/paths/list`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) return {};
      const body = await r.json();
      const out = {};
      for (const i of body.items || []) out[i.name] = Boolean(i.ready);
      return out;
    } catch {
      return {};
    }
  }

  async close() {
    /* global fetch keeps no persistent client to close */
  }
}
