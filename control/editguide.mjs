// Manual-edit "edit guide" for a session: every recorded clip with its exact
// start offset on the session timeline (so it can be placed in an NLE like
// CapCut), in order, per camera, plus the take/switch log — as CSV and a
// self-contained visual-timeline HTML. Reuses buildClips() so the offsets are the
// SAME math the preview/export use (start = mtime − duration − sessionStart).
import { buildClips } from './exports.mjs';

const round3 = (x) => Math.round(x * 1000) / 1000;
const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
// HH:MM:SS.mmm
export const tc = (sec) => {
  sec = Math.max(0, sec || 0);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${pad(sec / 3600)}:${pad((sec / 60) % 60)}:${pad(sec % 60)}.${pad(ms, 3)}`;
};
// HH:MM:SS:FF
const tcFrames = (sec, fps = 30) => {
  sec = Math.max(0, sec || 0);
  const f = Math.round((sec - Math.floor(sec)) * fps) % fps;
  return `${pad(sec / 3600)}:${pad((sec / 60) % 60)}:${pad(sec % 60)}:${pad(f)}`;
};
const baseName = (p) => String(p).split(/[\\/]/).pop();

// Flatten a session's probed clips into ordered timeline rows + the take list.
// Async (buildClips probes durations); the rest of the module is pure formatting.
export async function buildEditGuide(session) {
  const clips = await buildClips(session);
  const dur = session.durationSec || 0;
  const camById = new Map((session.cameras || []).map((c) => [c.id, c]));
  const rows = [];
  for (const cam of (session.cameras || [])) {
    const entry = clips[cam.id];
    if (!entry) continue;
    entry.segs.forEach((s, i) => rows.push({
      camId: cam.id, label: cam.label || cam.id, kind: cam.kind || 'video',
      idx: i + 1, start: s.start, dur: s.dur, end: round3(s.start + s.dur), name: baseName(s.file), path: s.file,
    }));
  }
  rows.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) || (a.start - b.start));
  const takes = (session.switches || []).slice().sort((a, b) => a.offset - b.offset)
    .map((s, i, arr) => ({ start: s.offset, end: i + 1 < arr.length ? arr[i + 1].offset : dur, camId: s.camId, label: s.label || camById.get(s.camId)?.label || s.camId }));
  return {
    sessionId: session.sessionId, name: session.name || '', startedAt: session.startedAt || 0, dur, rows, takes,
    cameras: (session.cameras || []).map((c) => ({ id: c.id, label: c.label || c.id, kind: c.kind || 'video' })),
  };
}

const csvEsc = (s) => `"${String(s).replace(/"/g, '""')}"`;
export function editGuideCsv(g) {
  const header = ['Camera', 'Kind', 'Clip #', 'Start (TC)', 'Start (frames@30)', 'Start (sec)', 'Duration (sec)', 'End (TC)', 'Filename', 'Full path'];
  const lines = [header.map(csvEsc).join(',')];
  for (const r of g.rows) {
    lines.push([r.label, r.kind, r.idx, tc(r.start), tcFrames(r.start), r.start.toFixed(3), r.dur.toFixed(3), tc(r.end), r.name, r.path].map(csvEsc).join(','));
  }
  return lines.join('\r\n');
}

const htmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PALETTE = ['#3b82f6', '#16a34a', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#ef4444'];

export function editGuideHtml(g) {
  const dur = g.dur || 0;
  const colorOf = (id) => PALETTE[g.cameras.findIndex((c) => c.id === id) % PALETTE.length];
  const pct = (v) => (100 * v / (dur || 1)).toFixed(3) + '%';
  const startedWall = g.startedAt ? new Date(g.startedAt * 1000).toLocaleString() : '';
  const step = dur > 3600 ? 600 : dur > 600 ? 120 : 30;
  const ruler = [];
  for (let t = 0; t <= dur; t += step) ruler.push(t);
  const title = g.name || g.sessionId;
  const lanes = g.cameras.filter((c) => g.rows.some((r) => r.camId === c.id)).map((c) => {
    const clips = g.rows.filter((r) => r.camId === c.id).map((r) =>
      `<div class="clip" style="left:${pct(r.start)};width:${pct(r.dur)};background:${colorOf(c.id)}" title="${htmlEsc(r.label)} #${r.idx}\n${htmlEsc(r.name)}\nstart ${tc(r.start)}  dur ${r.dur.toFixed(1)}s  end ${tc(r.end)}">${r.idx}</div>`).join('');
    const takes = c.kind === 'audio' ? '' : g.takes.map((t) => `<div class="take" style="left:${pct(t.start)}" title="take ${htmlEsc(t.label)} @ ${tc(t.start)}"></div>`).join('');
    return `<div class="lane"><span class="lane-label">${htmlEsc(c.label)}${c.kind === 'audio' ? ' (mic)' : ''}</span>${clips}${takes}</div>`;
  }).join('');
  const tableRows = g.rows.map((r) =>
    `<tr><td><span class="dot" style="background:${colorOf(r.camId)}"></span>${htmlEsc(r.label)}${r.kind === 'audio' ? ' (mic)' : ''}</td><td>${r.idx}</td><td class="tc">${tc(r.start)}</td><td class="tc">${tcFrames(r.start)}</td><td class="tc">${r.dur.toFixed(2)}s</td><td class="tc">${tc(r.end)}</td><td>${htmlEsc(r.name)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Edit guide · ${htmlEsc(title)}</title>
<style>
  body { background:#0d0d0d; color:#e8e8e8; font:14px/1.4 system-ui,Segoe UI,Roboto,sans-serif; margin:0; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; } .sub { color:#888; font-size:13px; margin-bottom:14px; }
  a.dl { display:inline-block; margin-bottom:18px; color:#7dd3fc; font-size:13px; }
  .legend { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:14px; font-size:12px; color:#bbb; }
  .legend i { display:inline-block; width:11px; height:11px; border-radius:3px; margin-right:5px; vertical-align:-1px; }
  .tl { position:relative; border:1px solid #222; border-radius:10px; padding:8px 0; background:#121212; overflow:hidden; }
  .lane { position:relative; height:46px; margin:6px 0; }
  .lane-label { position:absolute; left:8px; top:6px; font-size:12px; font-weight:600; z-index:3; color:#ddd; text-shadow:0 1px 2px #000; }
  .clip { position:absolute; top:18px; height:22px; border-radius:4px; box-sizing:border-box; border:1px solid rgba(255,255,255,.25); overflow:hidden; font-size:10px; color:#000; white-space:nowrap; padding:3px 5px; }
  .clip:hover { outline:1px solid #fff; z-index:4; }
  .ruler { position:relative; height:18px; margin-top:2px; border-top:1px solid #222; }
  .gl { position:absolute; top:0; height:2000px; width:1px; background:#1c1c1c; }
  .gl span { position:absolute; top:2px; left:3px; font-size:10px; color:#666; }
  .take { position:absolute; top:0; bottom:0; width:2px; background:rgba(239,68,68,.55); z-index:2; }
  table { border-collapse:collapse; width:100%; margin-top:22px; font-size:12px; }
  th,td { text-align:left; padding:6px 9px; border-bottom:1px solid #1f1f1f; }
  th { color:#888; font-weight:600; } td.tc { font-variant-numeric:tabular-nums; color:#cfe9ff; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; vertical-align:-1px; }
</style></head><body>
<h1>Edit guide — ${htmlEsc(title)}</h1>
<div class="sub">Recorded ${htmlEsc(startedWall)} · length ${tc(dur)} · ${g.rows.length} clips across ${g.cameras.length} sources. All offsets are from session start (00:00:00). Place each clip's start at its offset — or use the aligned-angle export to skip placement entirely.</div>
<a class="dl" href="/api/export/editguide.csv?id=${encodeURIComponent(g.sessionId)}" download>⭳ Download as CSV (spreadsheet)</a>
<div class="legend">${g.cameras.map((c) => `<span><i style="background:${colorOf(c.id)}"></i>${htmlEsc(c.label)}${c.kind === 'audio' ? ' (mic)' : ''}</span>`).join('')}<span><i style="background:#ef4444"></i>take (program switch)</span></div>
<div class="tl">${lanes}<div class="ruler">${ruler.map((t) => `<div class="gl" style="left:${pct(t)}"><span>${tc(t).slice(0, 8)}</span></div>`).join('')}</div></div>
<table><tr><th>Source</th><th>#</th><th>Start</th><th>Frames@30</th><th>Duration</th><th>End</th><th>File</th></tr>${tableRows}</table>
</body></html>`;
}
