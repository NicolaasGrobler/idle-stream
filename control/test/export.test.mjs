// Pure-function tests for the session export planner. These don't spawn ffmpeg
// (kept hermetic, like the rest of the suite) — they lock in the session-time →
// clip-time mapping, the black-filler decomposition (pre-roll, missing clip,
// late-joining camera, footage running out mid-take), and the clip mtime match.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planSegments, planParts, fileForCam, planXfade, sectionAudio, lastErrorLine, codecForPart, planCameraParts } from '../exports.mjs';
import { editGuideCsv } from '../editguide.mjs';

test('planSegments: no switches -> one segment on the first camera', () => {
  const s = { durationSec: 10, cameras: [{ id: 'cam1' }, { id: 'cam2' }], switches: [] };
  assert.deepEqual(planSegments(s), [{ start: 0, end: 10, camId: 'cam1' }]);
});

test('planSegments: pre-roll gap + ordered takes to durationSec', () => {
  const s = { durationSec: 20, cameras: [{ id: 'cam1' }], switches: [{ offset: 5, camId: 'cam1' }, { offset: 12, camId: 'cam2' }] };
  assert.deepEqual(planSegments(s), [
    { start: 0, end: 5, camId: null },     // before the first take
    { start: 5, end: 12, camId: 'cam1' },
    { start: 12, end: 20, camId: 'cam2' },
  ]);
});

test('planParts: footage covering a segment fully -> one footage part', () => {
  const s = { startedAt: 1000, durationSec: 6, cameras: [{ id: 'cam1', recordStartedAt: 1000 }], switches: [{ offset: 0, camId: 'cam1' }] };
  const clips = { cam1: { segs: [{ file: 'a.mp4', dur: 30, hasAudio: true, start: 0 }] } };
  assert.deepEqual(planParts(s, clips), [{ type: 'footage', file: 'a.mp4', clipIn: 0, dur: 6, hasAudio: true }]);
});

test('planParts: footage that runs out mid-take is padded with black', () => {
  const s = {
    startedAt: 1000, durationSec: 12,
    cameras: [{ id: 'cam1', recordStartedAt: 1000 }, { id: 'cam2', recordStartedAt: 1005 }],
    switches: [{ offset: 0, camId: 'cam1' }, { offset: 6, camId: 'cam2' }],
  };
  // cam1 long clip; cam2 only 2s of footage, starting 5s into the session.
  const clips = {
    cam1: { segs: [{ file: 'a.mp4', dur: 30, hasAudio: true, start: 0 }] },
    cam2: { segs: [{ file: 'b.mp4', dur: 2, hasAudio: false, start: 5 }] },
  };
  assert.deepEqual(planParts(s, clips), [
    { type: 'footage', file: 'a.mp4', clipIn: 0, dur: 6, hasAudio: true },
    { type: 'footage', file: 'b.mp4', clipIn: 1, dur: 1, hasAudio: false },   // session 6..7 -> clip 1..2
    { type: 'black', dur: 5 },                                                // session 7..12 has no footage
  ]);
});

test('planParts: a late-joining camera gets a black head', () => {
  const s = { startedAt: 1000, durationSec: 12, cameras: [{ id: 'cam1', recordStartedAt: 1003 }], switches: [{ offset: 0, camId: 'cam1' }] };
  const clips = { cam1: { segs: [{ file: 'a.mp4', dur: 30, hasAudio: true, start: 3 }] } };
  assert.deepEqual(planParts(s, clips), [
    { type: 'black', dur: 3 },                                                // before cam1's footage starts
    { type: 'footage', file: 'a.mp4', clipIn: 0, dur: 9, hasAudio: true },
  ]);
});

test('planParts: a camera with no clip -> black for the whole segment', () => {
  const s = { startedAt: 1000, durationSec: 8, cameras: [{ id: 'cam1', recordStartedAt: 1000 }], switches: [{ offset: 0, camId: 'cam1' }] };
  assert.deepEqual(planParts(s, {}), [{ type: 'black', dur: 8 }]);
});

test('planXfade: offsets overlap each pair by the fade; total shrinks by (N-1)*fade', () => {
  const parts = [{ dur: 5 }, { dur: 4 }, { dur: 6 }];
  const p = planXfade(parts, 0.5);
  assert.equal(p.fade, 0.5);
  // L0=5 -> O1=4.5; L1=5+4-0.5=8.5 -> O2=8.0; L2=8.5+6-0.5=14
  assert.deepEqual(p.offsets, [4.5, 8.0]);
  assert.equal(p.total, 14);                       // 15 raw - 2*0.5
});

test('planXfade: clamps the fade to the shortest part, and bails when too short', () => {
  // Shortest part 0.4s: fade clamped to 0.4-0.05=0.35 even though 0.5 was asked.
  assert.equal(planXfade([{ dur: 3 }, { dur: 0.4 }, { dur: 3 }], 0.5).fade, 0.35);
  // A part shorter than the 0.1 floor -> crossfade can't apply (caller hard-cuts).
  assert.equal(planXfade([{ dur: 3 }, { dur: 0.12 }, { dur: 3 }], 0.5), null);
  assert.equal(planXfade([{ dur: 5 }], 0.5), null);            // single part -> no transition
});

test('lastErrorLine: pulls the real error out of an ffmpeg banner dump', () => {
  // The concat failure from the field report: the banner + the actual error. We
  // want the meaningful line, not the version string.
  const dump = [
    'ffmpeg version N-1 Copyright (c) 2000-2026',
    '  configuration: --extra-version=20260530',
    '  libavutil 60. 31.100',
    "[in#0 @ 000002896fa80ec0] Impossible to open 'seg0000.ts'",
    'Error opening input file list.txt.',
    'Error opening input files: Invalid data found when processing input',
  ].join('\n');
  assert.equal(lastErrorLine(dump), 'Error opening input files: Invalid data found when processing input');
  // No error-ish line -> fall back to the last non-empty line.
  assert.equal(lastErrorLine('frame=  10\nframe=  20\n'), 'frame=  20');
  assert.equal(lastErrorLine(''), '');
});

test('sectionAudio: explicit override wins; else linked mic; else camera-only', () => {
  const session = {
    cameras: [{ id: 'cam1', kind: 'video' }, { id: 'mic1', kind: 'audio', link: 'cam1' }],
    audioRouting: { 1: { mic: 'mic1', mode: 'replace', camVol: 0.5, micVol: 1.5 } },
  };
  assert.deepEqual(sectionAudio(session, { camId: 'cam1' }, 1), { micId: 'mic1', mode: 'replace', camVol: 0.5, micVol: 1.5 });
  assert.deepEqual(sectionAudio(session, { camId: 'cam1' }, 0), { micId: 'mic1', mode: 'mix', camVol: 1, micVol: 1 });   // linked default
  assert.deepEqual(sectionAudio({ cameras: [] }, { camId: 'cam2' }, 0), { micId: null, mode: 'mix', camVol: 1, micVol: 1 });
});

test('planParts: a linked mic attaches an audio mix to the part; no link -> no audio field', () => {
  const session = {
    startedAt: 1000, durationSec: 6,
    cameras: [{ id: 'cam1', kind: 'video', recordStartedAt: 1000 }, { id: 'mic1', kind: 'audio', link: 'cam1', recordStartedAt: 1000 }],
    switches: [{ offset: 0, camId: 'cam1' }],
  };
  const clips = { cam1: { segs: [{ file: 'a.mp4', dur: 30, hasAudio: true, start: 0 }] }, mic1: { segs: [{ file: 'm.mp4', dur: 30, hasAudio: true, start: 0 }] } };
  const parts = planParts(session, clips);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].audio, { mode: 'mix', camVol: 1, micVol: 1, micFile: 'm.mp4', micIn: 0 });

  const noLink = { ...session, cameras: [{ id: 'cam1', kind: 'video', recordStartedAt: 1000 }] };
  assert.equal(planParts(noLink, clips)[0].audio, undefined);   // byte-identical to before
});

test('planParts: a camera split by a reconnect stitches both segments with a black gap', () => {
  const s = {
    startedAt: 1000, durationSec: 20,
    cameras: [{ id: 'cam1', recordStartedAt: 1000 }],
    switches: [{ offset: 0, camId: 'cam1' }],
  };
  // cam1 recorded 0..8 (pre-blip), the phone dropped, then came back 12..20 — a 4s
  // gap where MediaMTX had no publisher. Both files must appear, gap filled black.
  const clips = { cam1: { segs: [
    { file: 'a.mp4', dur: 8, hasAudio: true, start: 0 },
    { file: 'b.mp4', dur: 8, hasAudio: true, start: 12 },
  ] } };
  assert.deepEqual(planParts(s, clips), [
    { type: 'footage', file: 'a.mp4', clipIn: 0, dur: 8, hasAudio: true },   // session 0..8
    { type: 'black', dur: 4 },                                               // 8..12 link down
    { type: 'footage', file: 'b.mp4', clipIn: 0, dur: 8, hasAudio: true },   // 12..20 reconnect
  ]);
});

test('codecForPart: ultra-short parts force libx264; normal parts keep the hardware codec', () => {
  // Regression: a hardware encoder (NVENC) can emit ZERO video frames for a
  // sub-frame segment, yielding an audio-only .ts; as the concat-copy stitch
  // templates stream layout on the first segment, that drops video from the whole
  // export. Short parts (black alignment fillers, quick double-takes) must fall
  // back to libx264, which reliably produces at least one frame.
  assert.equal(codecForPart(0.072, 'h264_nvenc'), 'libx264');   // the field-report case
  assert.equal(codecForPart(0.05, 'h264_nvenc'), 'libx264');    // smallest part planParts emits
  assert.equal(codecForPart(0.49, 'h264_qsv'), 'libx264');      // just under the threshold
  assert.equal(codecForPart(0.5, 'h264_nvenc'), 'h264_nvenc');  // at/over the threshold: hardware
  assert.equal(codecForPart(120, 'h264_nvenc'), 'h264_nvenc');
  assert.equal(codecForPart(0.01, 'libx264'), 'libx264');       // already software: unchanged
});

test('planCameraParts: a single clip covering the session -> one footage part', () => {
  const segs = [{ file: 'a.mp4', dur: 30, hasAudio: true, start: 0 }];
  assert.deepEqual(planCameraParts({ durationSec: 10 }, segs), [
    { type: 'footage', file: 'a.mp4', clipIn: 0, dur: 10, hasAudio: true },
  ]);
});

test('planCameraParts: late start + early end -> black head, footage, black tail', () => {
  const segs = [{ file: 'a.mp4', dur: 5, hasAudio: false, start: 3 }];   // footage covers 3..8
  assert.deepEqual(planCameraParts({ durationSec: 20 }, segs), [
    { type: 'black', dur: 3 },
    { type: 'footage', file: 'a.mp4', clipIn: 0, dur: 5, hasAudio: false },
    { type: 'black', dur: 12 },
  ]);
});

test('planCameraParts: a reconnect gap is filled black between the two clips', () => {
  const segs = [
    { file: 'a.mp4', dur: 8, hasAudio: true, start: 0 },    // 0..8
    { file: 'b.mp4', dur: 8, hasAudio: true, start: 12 },   // 12..20
  ];
  assert.deepEqual(planCameraParts({ durationSec: 20 }, segs), [
    { type: 'footage', file: 'a.mp4', clipIn: 0, dur: 8, hasAudio: true },
    { type: 'black', dur: 4 },
    { type: 'footage', file: 'b.mp4', clipIn: 0, dur: 8, hasAudio: true },
  ]);
});

test('planCameraParts: no footage -> all black for the whole session', () => {
  assert.deepEqual(planCameraParts({ durationSec: 8 }, []), [{ type: 'black', dur: 8 }]);
});

test('editGuideCsv: header + a row with timecode-formatted offsets', () => {
  const csv = editGuideCsv({ rows: [{ label: 'Cam A', kind: 'video', idx: 1, start: 65.5, dur: 10, end: 75.5, name: 'x.mp4', path: '/r/x.mp4' }] });
  const lines = csv.split('\r\n');
  assert.match(lines[0], /^"Camera","Kind","Clip #","Start \(TC\)"/);
  assert.match(lines[1], /^"Cam A","video","1","00:01:05\.500","00:01:05:15","65\.500","10\.000","00:01:15\.500","x\.mp4","\/r\/x\.mp4"$/);
});

test('fileForCam: picks the largest clip (bulk footage) inside the session mtime window', () => {
  // A reconnect splits a camera into a long pre-blip file plus a short tail with a
  // LATER mtime. The matcher must pick the bulk file, not the tail; out-of-window
  // files are excluded even though they're larger.
  const recCams = [{ cam: 'cam1', files: [
    { name: 'before.mp4', modified: 500, sizeBytes: 9_000_000 },   // out of window
    { name: 'bulk.mp4', modified: 1005, sizeBytes: 8_000_000 },    // the long pre-blip recording
    { name: 'tail.mp4', modified: 1009, sizeBytes: 200_000 },      // short reconnect tail (latest mtime)
    { name: 'after.mp4', modified: 2000, sizeBytes: 9_000_000 },   // out of window
  ] }];
  const s = { startedAt: 1000, stoppedAt: 1012 };
  assert.equal(fileForCam(recCams, 'cam1', s), 'bulk.mp4');
  assert.equal(fileForCam(recCams, 'camX', s), null);   // no such camera
});
