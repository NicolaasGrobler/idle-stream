// Pure-function tests for the session export planner. These don't spawn ffmpeg
// (kept hermetic, like the rest of the suite) — they lock in the session-time →
// clip-time mapping, the black-filler decomposition (pre-roll, missing clip,
// late-joining camera, footage running out mid-take), and the clip mtime match.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planSegments, planParts, fileForCam, planXfade, sectionAudio } from '../exports.mjs';

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
