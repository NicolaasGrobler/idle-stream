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

// Expand segments into concrete render parts: footage cuts and black fillers.
// `clips` = { camId: { file, dur, hasAudio, delay } }. Pure (no ffmpeg).
export function planParts(session, clips) {
  const parts = [];
  for (const seg of planSegments(session)) {
    const segDur = round3(seg.end - seg.start);
    const c = seg.camId ? clips[seg.camId] : null;
    if (c && c.file && c.dur > 0) {
      const delay = c.delay || 0;
      const availStart = Math.max(seg.start, delay);
      const availEnd = Math.min(seg.end, delay + c.dur);
      if (availEnd - availStart > 0.05) {
        if (availStart - seg.start > 0.05) parts.push({ type: 'black', dur: round3(availStart - seg.start) });
        parts.push({ type: 'footage', file: c.file, clipIn: round3(availStart - delay), dur: round3(availEnd - availStart), hasAudio: !!c.hasAudio });
        if (seg.end - availEnd > 0.05) parts.push({ type: 'black', dur: round3(seg.end - availEnd) });
        continue;
      }
    }
    parts.push({ type: 'black', dur: segDur });
  }
  return parts;
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

// Identical encode params across every part so the TS segments concat-copy.
const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-r', String(FPS), '-c:a', 'aac', '-b:a', '160k', '-ar', String(AR), '-ac', '2',
  '-video_track_timescale', '90000', '-f', 'mpegts'];
const VF = `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}`;

function partArgs(part, out) {
  if (part.type === 'black') {
    return ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${OUT_W}x${OUT_H}:r=${FPS}`,
      '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${AR}`,
      '-t', String(part.dur), ...ENC, out];
  }
  if (part.hasAudio) {
    return ['-y', '-ss', String(part.clipIn), '-i', part.file, '-t', String(part.dur),
      '-vf', VF, '-af', `aresample=${AR}`, ...ENC, out];
  }
  // footage with no audio track -> synthesize matching silence
  return ['-y', '-ss', String(part.clipIn), '-i', part.file,
    '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${AR}`,
    '-t', String(part.dur), '-map', '0:v:0', '-map', '1:a:0', '-vf', VF, ...ENC, out];
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
export function startExport(session) {
  const id = session && session.sessionId;
  if (!SAFE_ID.test(id || '')) throw new Error('bad session id');
  const existing = jobs.get(id);
  if (existing && existing.status === 'running') return existing;
  const job = { status: 'running', progress: 0, error: null, file: null };
  jobs.set(id, job);
  runExport(session, job).catch((e) => { job.status = 'error'; job.error = String(e.message || e); });
  return job;
}

async function runExport(session, job) {
  mkdirSync(EXPORTS, { recursive: true });
  const work = join(EXPORTS, `.work-${session.sessionId}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const clips = await buildClips(session);
    const parts = planParts(session, clips);
    if (!parts.length) throw new Error('nothing to export (no segments)');
    const ff = ffmpegPath();
    const listLines = [];
    for (let i = 0; i < parts.length; i++) {
      const seg = `seg${String(i).padStart(4, '0')}.ts`;
      await run(ff, partArgs(parts[i], seg), work);
      listLines.push(`file '${seg}'`);
      job.progress = round3((i + 1) / (parts.length + 1));   // leave headroom for concat
    }
    writeFileSync(join(work, 'list.txt'), listLines.join('\n'));
    const out = join(EXPORTS, `${session.sessionId}.mp4`);
    rmSync(out, { force: true });
    await run(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', out], work);
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
