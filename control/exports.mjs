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
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync, openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { listRecordings, resolveRecording } from './recordings.mjs';
import { serveRangedFile } from './http-range.mjs';

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

// Below this part length, force the software encoder regardless of the detected
// hardware one. Hardware H.264 encoders (notably NVENC) can emit ZERO video
// frames for an ultra-short clip — their internal encode delay/lookahead swallows
// a sub-~0.15s segment whole, producing an audio-only .ts. The final stitch is a
// concat-demuxer copy that takes its stream layout from the FIRST segment, so a
// single video-less segment at the head silently drops video from the ENTIRE
// export (audio-only output). Tiny segments (black alignment fillers, quick
// double-takes) are trivial to encode, so libx264 — which reliably produces at
// least one frame down to a single-frame clip — handles them at negligible cost.
// Mixed encoders concat cleanly: the TS intermediates carry in-band SPS/PPS.
const MIN_HW_SEG_S = 0.5;
// The encoder for one render part: the detected (possibly hardware) codec for
// normal-length parts, libx264 for very short ones. Pure — unit-tested.
export const codecForPart = (durSec, vcodec) => (durSec < MIN_HW_SEG_S ? 'libx264' : vcodec);

// Prefer the downloaded static build; fall back to a PATH binary.
const toolPath = (name) => (existsSync(join(TOOLS, name + exe)) ? join(TOOLS, name + exe) : name);
const ffmpegPath = () => toolPath('ffmpeg');
const ffprobePath = () => toolPath('ffprobe');

const jobs = new Map();   // sessionId -> { status, progress, error, file }

export const getJob = (id) => jobs.get(id) || null;
export function getAllJobs() {
  const out = {};
  for (const [id, j] of jobs) out[id] = { status: j.status, progress: j.progress, error: j.error || null, ready: j.status === 'done' && !!j.file && existsSync(j.file) };
  return out;
}

function exportFile(id) {
  if (!SAFE_ID.test(id || '')) return null;
  const f = join(EXPORTS, `${id}.mp4`);
  return existsSync(f) ? f : null;
}

// Match a session to one clip file per camera by mtime window (filenames are
// local-time; mtime is the reliable key). Mirrors the dashboard's fileForCam.
// A mid-session disconnect/reconnect splits a camera across several files; pick
// the largest (the bulk footage), not the latest mtime (the short reconnect tail).
// NOTE: this still renders only ONE file per camera — a session split into two
// substantial clips loses the other to black filler. The full fix is to stitch
// every segment (see the dashboard preview); the export needs the same treatment.
export function fileForCam(recCams, camId, session) {
  const cands = filesForCam(recCams, camId, session);
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.sizeBytes > a.sizeBytes ? b : a)).name;
}

// Every clip file for a camera inside the session window, oldest first. A
// disconnect/reconnect produces several; the export stitches them all (see
// buildClips/planParts).
export function filesForCam(recCams, camId, session) {
  const entry = (recCams || []).find((c) => c.cam === camId);
  if (!entry || !entry.files.length) return [];
  const lo = (session.startedAt || 0) - 2, hi = (session.stoppedAt || 0) + 10;
  return entry.files
    .filter((f) => f.modified >= lo && f.modified <= hi)
    .slice()
    .sort((a, b) => a.modified - b.modified);
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

// Of a mic's segments, the one with the most overlap with [start, start+dur)
// (or null if none meaningfully overlaps). A mic can split on reconnect just like
// a camera; a render part takes the dominant segment's audio.
function micSegOverlapping(segs, start, dur) {
  const end = start + dur;
  let best = null, bestOv = 0.05;
  for (const m of (segs || [])) {
    if (!m.file || m.dur <= 0) continue;
    const ov = Math.min(end, m.start + m.dur) - Math.max(start, m.start);
    if (ov > bestOv) { bestOv = ov; best = m; }
  }
  return best;
}

// Expand segments into concrete render parts: footage cuts and black fillers.
// `clips` = { camId: { segs: [{ file, dur, hasAudio, start }] } }. A camera can
// have several segments (a disconnect/reconnect split); each program segment is
// covered by walking its segments in order, filling gaps (and the head/tail) with
// black. Pure (no ffmpeg). A part gets an `audio` routing object only when it's
// non-trivial (a mic is mixed/replaced, or the camera volume isn't unity) — so
// the common case stays byte-identical and concat-copies.
export function planParts(session, clips) {
  const parts = [];
  const segs = planSegments(session);
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    const aud = sectionAudio(session, seg, si);
    const micSegs = aud.micId && clips[aud.micId] ? clips[aud.micId].segs : null;
    const add = (p, sessionStart) => {
      const ms = micSegs ? micSegOverlapping(micSegs, sessionStart, p.dur) : null;
      if (ms) {
        const micIn = round3(sessionStart - ms.start);
        if (micIn < ms.dur) {   // mic footage overlaps this part
          p.audio = { mode: aud.mode, camVol: aud.camVol, micVol: aud.micVol, micFile: ms.file, micIn: Math.max(0, micIn) };
        }
      }
      if (!p.audio && aud.camVol !== 1) p.audio = { mode: 'mix', camVol: aud.camVol, micVol: aud.micVol };
      parts.push(p);
    };
    const camSegs = (seg.camId && clips[seg.camId] ? clips[seg.camId].segs : [])
      .filter((c) => c.file && c.dur > 0)
      .slice()
      .sort((a, b) => a.start - b.start);
    let cursor = seg.start;
    for (const c of camSegs) {
      const availStart = Math.max(cursor, c.start);
      const availEnd = Math.min(seg.end, c.start + c.dur);
      if (availEnd - availStart > 0.05) {
        if (availStart - cursor > 0.05) add({ type: 'black', dur: round3(availStart - cursor) }, cursor);
        add({ type: 'footage', file: c.file, clipIn: round3(availStart - c.start), dur: round3(availEnd - availStart), hasAudio: !!c.hasAudio }, availStart);
        cursor = availEnd;
      }
      if (cursor >= seg.end - 0.05) break;
    }
    if (seg.end - cursor > 0.05) add({ type: 'black', dur: round3(seg.end - cursor) }, cursor);
  }
  return parts;
}

// Parts for ONE camera's continuous angle track spanning the WHOLE session
// [0, durationSec]: its clips dropped at their offsets, every gap (pre-roll,
// dropout, reconnect, tail) filled black. Unlike planParts (which follows the
// switch log to make the program), this keeps a single source running the entire
// length — so the aligned-angle export produces one full-length file per camera
// that all start at session-zero, making manual multi-cam editing a matter of
// stacking tracks and cutting. Pure (no ffmpeg); each part carries the camera's
// own audio (or silence under black). Mirrors planParts' footage/black walk.
export function planCameraParts(session, camSegs) {
  const dur = session.durationSec || 0;
  const parts = [];
  const segs = (camSegs || [])
    .filter((c) => c.file && c.dur > 0)
    .slice()
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const c of segs) {
    const availStart = Math.max(cursor, c.start);
    const availEnd = Math.min(dur, c.start + c.dur);
    if (availEnd - availStart > 0.05) {
      if (availStart - cursor > 0.05) parts.push({ type: 'black', dur: round3(availStart - cursor) });
      parts.push({ type: 'footage', file: c.file, clipIn: round3(availStart - c.start), dur: round3(availEnd - availStart), hasAudio: !!c.hasAudio });
      cursor = availEnd;
    }
    if (cursor >= dur - 0.05) break;
  }
  if (dur - cursor > 0.05) parts.push({ type: 'black', dur: round3(dur - cursor) });
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
      { timeout: 15000, windowsHide: true }, (err, stdout) => {
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

// Resolve + probe every clip per camera in the session, as ordered segments on
// the session timeline. A reconnect splits a camera into multiple files; each
// becomes a segment, placed by its own start time so gaps render as black.
export async function buildClips(session) {
  const recCams = listRecordings();
  const sessionStart = session.startedAt || 0;
  const clips = {};
  for (const cam of (session.cameras || [])) {
    const segs = [];
    for (const f of filesForCam(recCams, cam.id, session)) {
      const file = resolveRecording(cam.id, f.name);
      if (!file) continue;
      const { dur, hasAudio } = await ffprobe(file);
      if (dur <= 0) continue;
      // Segment start = its end (fs mtime) minus probed duration, relative to the
      // session start. mtime is the reliable clock (filenames are local-time) and
      // duration comes free from the probe we already run; the first segment lands
      // at ~the camera's recordStartedAt.
      const start = Math.max(0, round3((f.modified || sessionStart) - dur - sessionStart));
      segs.push({ file, dur, hasAudio, start });
    }
    if (segs.length) { segs.sort((a, b) => a.start - b.start); clips[cam.id] = { segs }; }
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
      console.log(`Export encoder (override): ${override}`);
      return override;
    }
    const ff = ffmpegPath();
    const candidates = process.platform === 'darwin'
      ? ['h264_videotoolbox', 'h264_nvenc']
      : ['h264_nvenc', 'h264_qsv', 'h264_amf'];
    for (const enc of candidates) {
      if (await testEncoder(ff, enc)) { console.log(`Export encoder: ${enc} (hardware)`); return enc; }
    }
    console.log('Export encoder: libx264 (software)');
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
  const ENC = encForTs(codecForPart(part.dur, vcodec));
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

// The most relevant line of an ffmpeg stderr dump — the last one that looks like
// an error — so the dashboard shows "Impossible to open 'seg0000.ts'" instead of
// the whole multi-line version banner. Exported for testing.
export function lastErrorLine(stderr) {
  const lines = String(stderr).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/error|invalid|impossible|no such|unable|failed|denied|permission|not found|no space/i.test(lines[i])) {
      return lines[i];
    }
  }
  return lines[lines.length - 1] || '';
}

function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) { resolve(); return; }
      console.error(`ffmpeg failed (exit ${code}):\n${err}`);   // full detail -> logs/control.err.log
      reject(new Error(`ffmpeg failed: ${lastErrorLine(err) || `exit ${code}`}`));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Confirm every rendered segment is actually openable before the stitch pass.
// A just-written file can be briefly locked by antivirus / a file indexer; rather
// than letting that surface as a cryptic concat failure, poll-open each one and
// only give up (with a clear message) after a few tries.
async function ensureReadable(paths, attempts = 5, delayMs = 200) {
  for (const p of paths) {
    let lastErr;
    let ok = false;
    for (let a = 0; a < attempts; a++) {
      try { closeSync(openSync(p, 'r')); ok = true; break; }
      catch (e) { lastErr = e; await sleep(delayMs); }
    }
    if (!ok) {
      const name = p.split(/[\\/]/).pop();
      throw new Error(`temp segment "${name}" is locked or missing (${(lastErr && lastErr.code) || lastErr}) — antivirus or file sync may be holding it; try the export again`);
    }
  }
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
  // Build the intermediate .ts segments in the OS temp dir, NOT inside the app
  // folder. If the install lives under a OneDrive-synced location (older builds
  // installed into Documents), OneDrive locks the freshly-written segments and the
  // concat pass fails to reopen them ("Impossible to open seg0000.ts"). %TEMP% is
  // local and unsynced. The random suffix also isolates a retried/concurrent run
  // of the same session from a previous one's scratch dir.
  const work = join(tmpdir(), `multicam-export-${session.sessionId}-${randomBytes(4).toString('hex')}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const vcodec = await detectVideoEncoder();   // hardware H.264 if available, else libx264 — cached
    const clips = await buildClips(session);
    const parts = planParts(session, clips);
    if (!parts.length) throw new Error('nothing to export (no segments)');
    const ff = ffmpegPath();
    const segName = (i) => `seg${String(i).padStart(4, '0')}.ts`;
    const segPaths = [];
    for (let i = 0; i < parts.length; i++) {
      const seg = segName(i);
      await run(ff, partArgs(parts[i], seg, vcodec), work);
      // Fail fast (and clearly) if the encoder produced nothing — far better than a
      // cryptic concat error many segments later.
      const segPath = join(work, seg);
      const st = existsSync(segPath) ? statSync(segPath) : null;
      if (!st || st.size === 0) {
        throw new Error(`render produced no data for segment ${i + 1}/${parts.length} — the ${vcodec} encoder may have failed; retry, or set MULTICAM_ENCODER=libx264`);
      }
      segPaths.push(segPath);
      job.progress = round3((i + 1) / (parts.length + 1));   // leave headroom for the final pass
    }
    const out = join(EXPORTS, `${session.sessionId}.mp4`);
    rmSync(out, { force: true });
    // Ride out a transient lock on any just-written segment before the stitch.
    await ensureReadable(segPaths);
    // Crossfade if requested AND it actually fits the parts; else hard-cut concat.
    const plan = opts.crossfade ? planXfade(parts, Number(opts.fade) || 0.5) : null;
    if (plan) {
      await run(ff, xfadeArgs(parts, segName, plan, out, vcodec), work);
    } else {
      // Absolute, forward-slash paths so concat never depends on cwd or on Windows
      // backslash quoting quirks.
      const listPath = join(work, 'list.txt');
      writeFileSync(listPath, segPaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
      await run(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', out], work);
    }
    job.file = out;
    job.progress = 1;
    job.status = 'done';
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ----- Aligned-angle export (one full-length file per camera, for manual edit) --
// Renders every camera as its own session-length track (footage at offsets, gaps
// black) so they all start at 0 and stay in sync when dropped onto separate NLE
// tracks — the fix for hand-editing a session with dropouts/reconnects. Files land
// in exports/<sessionId>-angles/ ON THIS MACHINE (the editor runs here), so the
// job returns the folder path rather than streaming anything back.
const angleJobs = new Map();   // sessionId -> { status, progress, error, dir, files }
export const getAngleJob = (id) => angleJobs.get(id) || null;
export function getAllAngleJobs() {
  const out = {};
  for (const [id, j] of angleJobs) out[id] = { status: j.status, progress: j.progress, error: j.error || null, dir: j.dir || null, files: j.files || [], ready: j.status === 'done' };
  return out;
}

const safeName = (s, fallback) => (String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || fallback);

export function startAngleExport(session) {
  const id = session && session.sessionId;
  if (!SAFE_ID.test(id || '')) throw new Error('bad session id');
  const existing = angleJobs.get(id);
  if (existing && existing.status === 'running') return existing;
  const job = { status: 'running', progress: 0, error: null, dir: null, files: [] };
  angleJobs.set(id, job);
  runAngleExport(session, job).catch((e) => { job.status = 'error'; job.error = String(e.message || e); });
  return job;
}

async function runAngleExport(session, job) {
  const outDir = join(EXPORTS, `${session.sessionId}-angles`);
  mkdirSync(outDir, { recursive: true });
  const vcodec = await detectVideoEncoder();
  const clips = await buildClips(session);
  // v1: video angles only (a mic clip has no video stream for the footage path).
  const plans = (session.cameras || [])
    .filter((c) => (c.kind || 'video') !== 'audio' && clips[c.id])
    .map((c) => ({ cam: c, parts: planCameraParts(session, clips[c.id].segs) }))
    .filter((p) => p.parts.length);
  if (!plans.length) throw new Error('no camera footage to export as angles');
  const totalUnits = plans.reduce((n, p) => n + p.parts.length + 1, 0);   // +1 concat per camera
  let done = 0;
  const ff = ffmpegPath();
  const files = [];
  const usedNames = new Set();
  for (const { cam, parts } of plans) {
    const work = join(tmpdir(), `multicam-angle-${session.sessionId}-${cam.id}-${randomBytes(4).toString('hex')}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      const segName = (i) => `seg${String(i).padStart(4, '0')}.ts`;
      const segPaths = [];
      for (let i = 0; i < parts.length; i++) {
        const seg = segName(i);
        await run(ff, partArgs(parts[i], seg, vcodec), work);
        const segPath = join(work, seg);
        const st = existsSync(segPath) ? statSync(segPath) : null;
        if (!st || st.size === 0) throw new Error(`render produced no data for ${cam.label || cam.id} segment ${i + 1}/${parts.length}`);
        segPaths.push(segPath);
        done++; job.progress = round3(done / totalUnits);
      }
      // Unique, filesystem-safe filename per camera (label first, id on collision).
      let base = safeName(cam.label || cam.id, cam.id);
      if (usedNames.has(base.toLowerCase())) base = `${base}_${cam.id}`;
      usedNames.add(base.toLowerCase());
      const out = join(outDir, `${base}.mp4`);
      rmSync(out, { force: true });
      await ensureReadable(segPaths);
      const listPath = join(work, 'list.txt');
      writeFileSync(listPath, segPaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
      await run(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', out], work);
      done++; job.progress = round3(done / totalUnits);
      files.push({ cam: cam.id, label: cam.label || cam.id, file: out, name: `${base}.mp4` });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  job.dir = outDir;
  job.files = files;
  job.progress = 1;
  job.status = 'done';
}

// Stream the finished export with HTTP Range (so the dashboard can download or
// the browser can play/seek it). Returns false if there's nothing to serve.
export function serveExport(id, req, res) {
  const file = exportFile(id);
  if (!file) return false;
  return serveRangedFile(file, req, res, {
    'content-type': 'video/mp4',
    'content-disposition': `inline; filename="${id}.mp4"`,
  });
}
