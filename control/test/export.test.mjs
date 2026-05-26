// Pure-function tests for the session export planner. These don't spawn ffmpeg
// (kept hermetic, like the rest of the suite) — they lock in the session-time →
// clip-time mapping, the black-filler decomposition (pre-roll, missing clip,
// late-joining camera, footage running out mid-take), and the clip mtime match.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planSegments, planParts, fileForCam } from '../exports.mjs';

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
  const clips = { cam1: { file: 'a.mp4', dur: 30, hasAudio: true, delay: 0 } };
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
    cam1: { file: 'a.mp4', dur: 30, hasAudio: true, delay: 0 },
    cam2: { file: 'b.mp4', dur: 2, hasAudio: false, delay: 5 },
  };
  assert.deepEqual(planParts(s, clips), [
    { type: 'footage', file: 'a.mp4', clipIn: 0, dur: 6, hasAudio: true },
    { type: 'footage', file: 'b.mp4', clipIn: 1, dur: 1, hasAudio: false },   // session 6..7 -> clip 1..2
    { type: 'black', dur: 5 },                                                // session 7..12 has no footage
  ]);
});

test('planParts: a late-joining camera gets a black head', () => {
  const s = { startedAt: 1000, durationSec: 12, cameras: [{ id: 'cam1', recordStartedAt: 1003 }], switches: [{ offset: 0, camId: 'cam1' }] };
  const clips = { cam1: { file: 'a.mp4', dur: 30, hasAudio: true, delay: 3 } };
  assert.deepEqual(planParts(s, clips), [
    { type: 'black', dur: 3 },                                                // before cam1's footage starts
    { type: 'footage', file: 'a.mp4', clipIn: 0, dur: 9, hasAudio: true },
  ]);
});

test('planParts: a camera with no clip -> black for the whole segment', () => {
  const s = { startedAt: 1000, durationSec: 8, cameras: [{ id: 'cam1', recordStartedAt: 1000 }], switches: [{ offset: 0, camId: 'cam1' }] };
  assert.deepEqual(planParts(s, {}), [{ type: 'black', dur: 8 }]);
});

test('fileForCam: picks the latest clip inside the session mtime window', () => {
  const recCams = [{ cam: 'cam1', files: [
    { name: 'before.mp4', modified: 500 },
    { name: 'in-early.mp4', modified: 1005 },
    { name: 'in-late.mp4', modified: 1009 },
    { name: 'after.mp4', modified: 2000 },
  ] }];
  const s = { startedAt: 1000, stoppedAt: 1012 };
  assert.equal(fileForCam(recCams, 'cam1', s), 'in-late.mp4');
  assert.equal(fileForCam(recCams, 'camX', s), null);   // no such camera
});
