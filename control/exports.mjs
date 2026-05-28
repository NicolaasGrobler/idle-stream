// Render a switch-log session into one finished MP4 (the program edit), the
// real deliverable vs. the in-browser preview.
//
// v1 scope (deliberate): single camera per program segment, **re-encoded** to a
// normalized H.264+AAC stream and concatenated. Re-encode is required because
// arbitrary cut points across switching sources can't be stream-copied cleanly
// (this is a one-shot export, NOT the live N-stream constraint the project
// avoids — see plan.md). The lossless per-angle clips remain the masters.
//
// Each program segment is cut from its camera's clip (session-time mapped to
// clip-time via the camera's recordStartedAt). Missing footage — a pre-roll
// gap, a camera with no clip, or a clip whose footage ran out before the take
// ended — is filled with black + silence so the output stays aligned with the
// logged offsets. The active camera's own audio is used per segment.
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listRecordings, resolveRecording } from './recordings.mjs';

const ROOT = process.env.MULTICAM_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'tools');
const EXPORTS = join(ROOT, 'exports');
const isWin = process.platform === 'win32';
const exe = isWin ? '.exe' : '';

// Output normalization — all intermediates share these so the final concat can
// stream-copy. MPEG-TS intermediates carry in-band SPS/PPS, so concatenating
// segments with different x264 headers remuxes cleanly to MP4.
const OUT_W = 1920, OUT_H = 1080, FPS = 30, AR = 48000;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const round3 = (x) => Math.round(x * 1000) / 1000;

// Prefer the downloaded static build; fall back to a PATH binary.
const toolPath = (name) => (existsSync(join(TOOLS, name + exe)) ? join(TOOLS, name + exe) : name);
export const ffmpegPath = () => toolPath('ffmpeg');
export const ffprobePath = () => toolPath('ffprobe');

const jobs = new Map();   // sessionId -> { status, progress, error, file }

export const getJob = (id) => jobs.get(id) || null;
export function getAllJobs() {
  const out = {};
  for (const [id, j] of jobs) out[id] = { status: j.status, progress: j.progress, error: j.error || null, ready: j.status === 'done' && !!j.file && existsSync(j.file) };
  return out;
}

export function exportFile(id) {
  if (!SAFE_ID.test(id || '')) return null;
  const f = join(EXPORTS, `${id}.mp4`);
  return existsSync(f) ? f : null;
}

// Match a session to one clip file per camera by mtime window (filenames are
// local-time; mtime is the reliable key). Mirrors the dashboard's fileForCam.
export function fileForCam(recCams, camId, session) {
  const entry = (recCams || []).find((c) => c.cam === camId);
  if (!entry || !entry.files.length) return null;
  const lo = (session.startedAt || 0) - 2, hi = (session.stoppedAt || 0) + 10;
  const cands = entry.files.filter((f) => f.modified >= lo && f.modified <= hi);
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.modified > a.modified ? b : a)).name;
}

// Ordered program segments from the switch log. Pure — mirrors the preview
// player so the export matches what the operator previewed.
export function planSegments(session) {
  const dur = session.durationSec || 0;
  const sw = (session.switches || []).slice().sort((a, b) => a.offset - b.offset);
  const segs = [];
  if (!sw.length) {
    const first = (session.cameras || [])[0];
    segs.push({ start: 0, end: dur, camId: first ? first.id : null });
  } else {
    if (sw[0].offset > 0.05) segs.push({ start: 0, end: sw[0].offset, camId: null });
    for (let i = 0; i < sw.length; i++) {
      segs.push({ start: sw[i].offset, end: i + 1 < sw.length ? sw[i + 1].offset : dur, camId: sw[i].camId });
    }
  }
  return segs.filter((s) => s.end - s.start > 0.05);
}

const clampVol = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(2, Math.round(n * 100) / 100) : dflt;
};

// Resolve a program section's audio routing. Precedence:
//   1. an explicit per-section override on the session (`audioRouting[segIndex]`)
//   2. else the section camera's linked mic (default mix at unity)
//   3. else the camera's own audio only.
// Returns { micId, mode:'mix'|'replace', camVol, micVol }. Pure.
export function sectionAudio(session, seg, segIndex) {
  const r = (session.audioRouting || {})[segIndex];
  if (r && typeof r === 'object') {
    return {
      micId: r.mic || null,
      mode: r.mode === 'replace' ? 'replace' : 'mix',
      camVol: clampVol(r.camVol, 1),
      micVol: clampVol(r.micVol, 1),
    };
  }
  const linked = (session.cameras || []).find((c) => c.kind === 'audio' && c.link && c.link === seg.camId);
  if (linked) return { micId: linked.id, mode: 'mix', camVol: 1, micVol: 1 };
  return { micId: null, mode: 'mix', camVol: 1, micVol: 1 };
}

// Expand segments into concrete render parts: footage cuts and black fillers.
// `clips` = { camId: { file, dur, hasAudio, delay } }. Pure (no ffmpeg).
// A part gets an `audio` routing object only when it's non-trivial (a mic is
// mixed/replaced, or the camera volume isn't unity) — so the common case stays
// byte-identical and concat-copies.
export function planParts(session, clips) {
  const parts = [];
  const segs = planSegments(session);
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    const aud = sectionAudio(session, seg, si);
    const micClip = aud.micId ? clips[aud.micId] : null;
    const add = (p, sessionStart) => {
      if (micClip && micClip.file && micClip.dur > 0) {
        const micIn = round3(sessionStart - (micClip.delay || 0));
        if (micIn + p.dur > 0.05 && micIn < micClip.dur) {   // mic footage overlaps this part
          p.audio = { mode: aud.mode, camVol: aud.camVol, micVol: aud.micVol, micFile: micClip.file, micIn: Math.max(0, micIn) };
        }
      }
      if (!p.audio && aud.camVol !== 1) p.audio = { mode: 'mix', camVol: aud.camVol, micVol: aud.micVol };
      parts.push(p);
    };
    const segDur = round3(seg.end - seg.start);
    const c = seg.camId ? clips[seg.camId] : null;
    if (c && c.file && c.dur > 0) {
      const delay = c.delay || 0;
      const availStart = Math.max(seg.start, delay);
      const availEnd = Math.min(seg.end, delay + c.dur);
      if (availEnd - availStart > 0.05) {
        if (availStart - seg.start > 0.05) add({ type: 'black', dur: round3(availStart - seg.start) }, seg.start);
        add({ type: 'footage', file: c.file, clipIn: round3(availStart - delay), dur: round3(availEnd - availStart), hasAudio: !!c.hasAudio }, availStart);
        if (seg.end - availEnd > 0.05) add({ type: 'black', dur: round3(seg.end - availEnd) }, availEnd);
        continue;
      }
    }
    add({ type: 'black', dur: segDur }, seg.start);
  }
  return parts;
}

// Plan a crossfade chain over the rendered parts. Pure (no ffmpeg) so the offset
// math is unit-tested. xfade/acrossfade overlap each consecutive pair by the fade
// duration, so the program shrinks by (N-1)*fade. Returns null when crossfade
// can't apply (fewer than 2 parts, or the shortest part is too short to fade) —
// the caller then falls back to a plain hard-cut concat.
//   offsets[k-1] = start time (in the accumulated stream) of the k-th transition.
export function planXfade(parts, fade) {
  if (!Array.isArray(parts) || parts.length < 2) return null;
  const minDur = Math.min(...parts.map((p) => p.dur || 0));
  const eff = Math.min(fade, round3(minDur - 0.05));
  if (!(eff >= 0.1)) return null;                 // shortest part can't host the fade
  const offsets = [];
  let len = parts[0].dur;
  for (let k = 1; k < parts.length; k++) {
    offsets.push(round3(len - eff));
    len = len + parts[k].dur - eff;
  }
  return { fade: round3(eff), offsets, total: round3(len) };
}

// ffmpeg args for the crossfade final pass: load every TS part and chain
// xfade (video) + acrossfade (audio). Inputs are already format-normalized, so
// the filtergraph is reliable; the result is re-encoded (filtergraph output
// can't be stream-copied).
function xfadeArgs(parts, segName, plan, out, vcodec) {
  const inputs = [];
  for (let i = 0; i < parts.length; i++) inputs.push('-i', segName(i));
  const vChain = [], aChain = [];
  let vLabel = '[0:v]', aLabel = '[0:a]';
  for (let k = 1; k < parts.length; k++) {
    const vOut = `[v${k}]`, aOut = `[a${k}]`;
    vChain.push(`${vLabel}[${k}:v]xfade=transition=fade:duration=${plan.fade}:offset=${plan.offsets[k - 1]}${vOut}`);
    aChain.push(`${aLabel}[${k}:a]acrossfade=d=${plan.fade}:c1=tri:c2=tri${aOut}`);
    vLabel = vOut; aLabel = aOut;
  }
  const filter = [...vChain, ...aChain].join(';');
  return ['-y', ...inputs, '-filter_complex', filter, '-map', vLabel, '-map', aLabel, ...encForMp4(vcodec), out];
}

function ffprobe(file) {
  return new Promise((resolve) => {
    execFile(ffprobePath(), ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type', '-of', 'json', file],
      { timeout: 15000 }, (err, stdout) => {
        if (err) return resolve({ dur: 0, hasAudio: false });
        try {
          const j = JSON.parse(stdout);
          const dur = parseFloat(j.format && j.format.duration) || 0;
          const hasAudio = (j.streams || []).some((s) => s.codec_type === 'audio');
          resolve({ dur, hasAudio });
        } catch { resolve({ dur: 0, hasAudio: false }); }
      });
  });
}

// Resolve + probe one clip per camera in the session.
async function buildClips(session) {
  const recCams = listRecordings();
  const sessionStart = session.startedAt || 0;
  const clips = {};
  for (const cam of (session.cameras || [])) {
    const name = fileForCam(recCams, cam.id, session);
    const file = name ? resolveRecording(cam.id, name) : null;
    if (!file) continue;
    const { dur, hasAudio } = await ffprobe(file);
    clips[cam.id] = { file, dur, hasAudio, delay: Math.max(0, (cam.recordStartedAt || sessionStart) - sessionStart) };
  }
  return clips;
}

// Per-encoder video flags (quality knobs only — the rest of the encode is shared).
// Order is preference: hardware first, libx264 as a guaranteed fallback.
function vEnc(name) {
  switch (name) {
    case 'h264_nvenc':        return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '22', '-b:v', '0'];
    case 'h264_qsv':          return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '22'];
    case 'h264_amf':          return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '22'];
    case 'h264_videotoolbox': return ['-c:v', 'h264_videotoolbox', '-q:v', '55'];
    default:                  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
  }
}
const COMMON_VIDEO = ['-pix_fmt', 'yuv420p', '-r', String(FPS)];
const COMMON_AUDIO = ['-c:a', 'aac', '-b:a', '160k', '-ar', String(AR), '-ac', '2'];
const TS_TAIL = ['-video_track_timescale', '90000', '-f', 'mpegts'];
const MP4_TAIL = ['-movflags', '+faststart'];
const encForTs = (vc) => [...vEnc(vc), ...COMMON_VIDEO, ...COMMON_AUDIO, ...TS_TAIL];
const encForMp4 = (vc) => [...vEnc(vc), ...COMMON_VIDEO, ...COMMON_AUDIO, ...MP4_TAIL];

// Probe the bundled ffmpeg for the fastest working H.264 encoder. Hardware
// encoders are listed in ffmpeg builds even where the GPU isn't present, so we
// run a 0.2s test encode on each candidate and pick the first that exits 0.
// Result is cached for the process lifetime. MULTICAM_ENCODER=libx264 (or any
// specific encoder name) skips detection and forces that choice.
let _vcodecPromise = null;
export function detectVideoEncoder() {
  if (_vcodecPromise) return _vcodecPromise;
  _vcodecPromise = (async () => {
    const override = process.env.MULTICAM_ENCODER;
    if (override && override !== 'auto') {
      console.log(`[exports] encoder (override): ${override}`);
      return override;
    }
    const ff = ffmpegPath();
    const candidates = process.platform === 'darwin'
      ? ['h264_videotoolbox', 'h264_nvenc']
      : ['h264_nvenc', 'h264_qsv', 'h264_amf'];
    for (const enc of candidates) {
      if (await testEncoder(ff, enc)) { console.log(`[exports] hardware encoder: ${enc}`); return enc; }
    }
    console.log('[exports] software encoder: libx264');
    return 'libx264';
  })();
  return _vcodecPromise;
}
function testEncoder(ff, enc) {
  return new Promise((resolve) => {
    const p = spawn(ff, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.2', '-c:v', enc, '-pix_fmt', 'yuv420p', '-f', 'null', '-'], { windowsHide: true });
    p.stderr.on('data', () => {});
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}
const VF = `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}`;

function partArgs(part, out, vcodec) {
  const ENC = encForTs(vcodec);
  // ----- simple path (no audio routing): byte-identical to before, concat-copies -----
  if (!part.audio) {
    if (part.type === 'black') {
      return ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${OUT_W}x${OUT_H}:r=${FPS}`,
        '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${AR}`,
        '-t', String(part.dur), ...ENC, out];
    }
    if (part.hasAudio) {
      return ['-y', '-ss', String(part.clipIn), '-i', part.file, '-t', String(part.dur),
        '-vf', VF, '-af', `aresample=${AR}`, ...ENC, out];
    }
    return ['-y', '-ss', String(part.clipIn), '-i', part.file,
      '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${AR}`,
      '-t', String(part.dur), '-map', '0:v:0', '-map', '1:a:0', '-vf', VF, ...ENC, out];
  }

  // ----- routed path: per-section volumes + optional mic mix/replace via a graph -----
  const a = part.audio;
  const inputs = [];
  let vLabel, camA, idx;
  if (part.type === 'black') {
    inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${OUT_W}x${OUT_H}:r=${FPS}`);
    inputs.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${AR}`);
    vLabel = '[0:v]'; camA = '[1:a]'; idx = 2;
  } else if (part.hasAudio) {
    inputs.push('-ss', String(part.clipIn), '-i', part.file);
    vLabel = '[0:v]'; camA = '[0:a]'; idx = 1;
  } else {
    inputs.push('-ss', String(part.clipIn), '-i', part.file);
    inputs.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${AR}`);
    vLabel = '[0:v]'; camA = '[1:a]'; idx = 2;
  }
  const hasMic = !!a.micFile;
  if (hasMic) inputs.push('-ss', String(a.micIn), '-i', a.micFile);
  const muteCam = hasMic && a.mode === 'replace';

  const fc = [];
  let vmap = vLabel;
  if (part.type !== 'black') { fc.push(`${vLabel}${VF}[v]`); vmap = '[v]'; }
  // apad the camera bed so amix (duration=first) never truncates; output -t caps length.
  fc.push(`${camA}aresample=${AR},volume=${muteCam ? 0 : a.camVol},apad[ca]`);
  let amap = '[ca]';
  if (hasMic) {
    fc.push(`[${idx}:a]aresample=${AR},volume=${a.micVol},apad[ma]`);
    fc.push(`[ca][ma]amix=inputs=2:duration=first:normalize=0[a]`);
    amap = '[a]';
  }
  return ['-y', ...inputs, '-t', String(part.dur), '-filter_complex', fc.join(';'),
    '-map', vmap, '-map', amap, ...ENC, out];
}

function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-600)}`))));
  });
}

// Kick off (or return) an async export for a session. Progress is part-based.
// opts: { crossfade: bool, fade: seconds } — crossfade dissolves between program
// segments (re-encode pass); otherwise the parts are hard-cut concatenated (copy).
export function startExport(session, opts = {}) {
  const id = session && session.sessionId;
  if (!SAFE_ID.test(id || '')) throw new Error('bad session id');
  const existing = jobs.get(id);
  if (existing && existing.status === 'running') return existing;
  const job = { status: 'running', progress: 0, error: null, file: null };
  jobs.set(id, job);
  runExport(session, job, opts).catch((e) => { job.status = 'error'; job.error = String(e.message || e); });
  return job;
}

async function runExport(session, job, opts = {}) {
  mkdirSync(EXPORTS, { recursive: true });
  const work = join(EXPORTS, `.work-${session.sessionId}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const vcodec = await detectVideoEncoder();   // hardware H.264 if available, else libx264 — cached
    const clips = await buildClips(session);
    const parts = planParts(session, clips);
    if (!parts.length) throw new Error('nothing to export (no segments)');
    const ff = ffmpegPath();
    const segName = (i) => `seg${String(i).padStart(4, '0')}.ts`;
    const listLines = [];
    for (let i = 0; i < parts.length; i++) {
      const seg = segName(i);
      await run(ff, partArgs(parts[i], seg, vcodec), work);
      listLines.push(`file '${seg}'`);
      job.progress = round3((i + 1) / (parts.length + 1));   // leave headroom for the final pass
    }
    const out = join(EXPORTS, `${session.sessionId}.mp4`);
    rmSync(out, { force: true });
    // Crossfade if requested AND it actually fits the parts; else hard-cut concat.
    const plan = opts.crossfade ? planXfade(parts, Number(opts.fade) || 0.5) : null;
    if (plan) {
      await run(ff, xfadeArgs(parts, segName, plan, out, vcodec), work);
    } else {
      writeFileSync(join(work, 'list.txt'), listLines.join('\n'));
      await run(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', out], work);
    }
    job.file = out;
    job.progress = 1;
    job.status = 'done';
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Stream the finished export with HTTP Range (so the dashboard can download or
// the browser can play/seek it). Returns false if there's nothing to serve.
export function serveExport(id, req, res) {
  const file = exportFile(id);
  if (!file) return false;
  const total = statSync(file).size;
  const base = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-disposition': `inline; filename="${id}.mp4"` };
  const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (m) {
    let start = m[1] === '' ? Math.max(0, total - Number(m[2] || 0)) : parseInt(m[1], 10);
    let end = m[2] === '' || Number(m[2]) >= total ? total - 1 : parseInt(m[2], 10);
    if (start > end || start >= total) { res.writeHead(416, { 'content-range': `bytes */${total}` }); res.end(); return true; }
    res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return true; }
    createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...base, 'content-length': total });
  if (req.method === 'HEAD') { res.end(); return true; }
  createReadStream(file).pipe(res);
  return true;
}
