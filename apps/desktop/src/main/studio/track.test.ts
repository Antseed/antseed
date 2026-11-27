import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  addStudioExport,
  applyStudioDelivery,
  applyTrackEdit,
  clipState,
  clipStaleReason,
  clipsTouching,
  undoTo,
  emptyStudioTrack,
  exportCheck,
  parseStudioAgentEdit,
  parseStudioTrack,
  sceneRuns,
  trackFromBoard,
  type StudioTrack,
  type TrackEdit,
} from '../../shared/studio-track.js';
import { parseStudioBoard, STUDIO_MEDIA_TOOLS_MISSING, sumStudioCost } from '../../shared/studio.js';
import { createStudioProject, getStudioProject } from './store.js';
import { detectStudioMediaTools, editStudioTrack, ingestStudioDeliveries, readStudioTrack, studioCanUndo, STUDIO_TRACK_TOO_LARGE } from './track.js';

const files = (...names: string[]) => ({ has: (file: string) => names.includes(file), seconds: () => 4 });
const all = files('stills/a.png', 'stills/b.png', 'stills/c.png', 'stills/new.png', 'clips/one.mp4', 'clips/two.mp4');
const edit = (track: StudioTrack, ...edits: TrackEdit[]) => edits.reduce((current, next) => applyTrackEdit(current, next, all, { now: 1 }), track);

function threeAnchors(): StudioTrack {
  return edit(emptyStudioTrack(),
    { type: 'add-anchor', index: 0, file: 'stills/a.png' },
    { type: 'add-anchor', index: 1, file: 'stills/b.png', scene: 'continue' },
    { type: 'add-anchor', index: 2, file: 'stills/c.png', scene: 'new' },
  );
}

test('anchors at the end continue the scene or start a new one, and every gap gets a clip slot', () => {
  const track = threeAnchors();
  assert.deepEqual(track.anchors.map((anchor) => anchor.image), ['stills/a.png', 'stills/b.png', 'stills/c.png']);
  assert.equal(track.anchors[0]!.clip!.then, 'extend');
  assert.equal(track.anchors[1]!.clip!.then, 'cut');
  assert.equal(track.anchors[2]!.clip, null);
  assert.deepEqual(sceneRuns(track).map((run) => run.anchors.length), [2, 1]);
  assert.deepEqual(exportCheck(track).blockers, ['Make or add at least one clip first.', 'Clip 1→2 is empty.', 'Clip 2→3 is empty.']);
});

test('inserting between two anchors splits the gap and asks for the new boundary', () => {
  const track = edit(threeAnchors(), { type: 'add-anchor', index: 1, file: 'stills/new.png' });
  assert.equal(track.anchors[0]!.clip!.then, null);
  assert.equal(track.anchors[1]!.clip!.then, 'extend');
  assert.ok(exportCheck(track).blockers.includes('Choose Cut or Extend after Clip 1→2.'));
});

test('replacing an image marks the clips made from it as made from an earlier image, and keeps the old image', () => {
  let track = edit(threeAnchors(), { type: 'request', clips: [threeAnchors().anchors[0]!.id], images: [] });
  assert.equal(clipState(track, 0), 'requested');
  track = parseStudioTrack({ ...track, anchors: track.anchors.map((anchor, index) => index === 0 ? { ...anchor, clip: { ...anchor.clip, use: 'clips/one.mp4', versions: [{ file: 'clips/one.mp4', from: 'stills/a.png', to: 'stills/b.png', seconds: 4 }] } } : anchor) });
  assert.equal(clipState(track, 0), 'ready');
  const replaced = edit(track, { type: 'set-image', anchor: track.anchors[1]!.id, file: 'stills/new.png' });
  assert.equal(clipState(replaced, 0), 'stale');
  assert.deepEqual(replaced.anchors[1]!.earlier, ['stills/b.png']);
  assert.deepEqual(exportCheck(replaced).stale, ['Clip 1→2']);
  const restored = edit(replaced, { type: 'set-image', anchor: track.anchors[1]!.id, file: 'stills/b.png' });
  assert.equal(clipState(restored, 0), 'ready');
  assert.deepEqual(restored.anchors[1]!.earlier, ['stills/new.png']);
});

test('a trim sets a new end frame and needs a decision; Extend makes that frame the next anchor', () => {
  const base = parseStudioTrack({
    anchors: [
      { id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: 'cut', use: 'clips/one.mp4', versions: [{ file: 'clips/one.mp4', from: 'stills/a.png', seconds: 4 }] } },
      { id: 'a2', image: 'stills/b.png', clip: { id: 'c2', then: null, use: 'clips/two.mp4', versions: [{ file: 'clips/two.mp4', from: 'stills/b.png', seconds: 4 }] } },
    ],
  });
  assert.throws(() => applyTrackEdit(base, { type: 'trim', anchor: 'a1', end: 9 }, all, { frame: 'frames/x.png' }), /inside the clip/);
  const trimmed = applyTrackEdit(base, { type: 'trim', anchor: 'a1', end: 2.5 }, all, { frame: 'frames/x.png' });
  assert.equal(trimmed.anchors[0]!.clip!.then, null);
  assert.equal(trimmed.anchors[0]!.clip!.end, 2.5);
  const cut = applyTrackEdit(trimmed, { type: 'then', anchor: 'a1', then: 'cut' }, all);
  assert.equal(cut.anchors[1]!.image, 'stills/b.png');
  const extended = applyTrackEdit(trimmed, { type: 'then', anchor: 'a1', then: 'extend' }, all);
  assert.equal(extended.anchors[1]!.image, 'frames/x.png');
  assert.deepEqual(extended.anchors[1]!.from, { clip: 'c1', at: 2.5, replaced: 'stills/b.png' });
  assert.deepEqual(extended.anchors[1]!.earlier, ['stills/b.png']);
  assert.equal(clipState(extended, 0), 'ready', 'the trimmed clip ends on its own frame');
  assert.equal(clipState(extended, 1), 'stale', 'the next clip started from the old image');
  // The last clip is open: extending its trimmed end adds an anchor after it.
  const open = applyTrackEdit(applyTrackEdit(base, { type: 'trim', anchor: 'a2', end: 1 }, all, { frame: 'frames/y.png' }), { type: 'then', anchor: 'a2', then: 'extend' }, all);
  assert.equal(open.anchors.length, 3);
  assert.equal(open.anchors[2]!.image, 'frames/y.png');
});

test('a trimmed Extend lands on its trim frame, so putting back the image it was made to end on makes it out of date', () => {
  const base = parseStudioTrack({
    anchors: [
      { id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: 'extend', use: 'clips/one.mp4', versions: [{ file: 'clips/one.mp4', from: 'stills/a.png', to: 'stills/b.png', seconds: 4 }] } },
      { id: 'a2', image: 'stills/b.png' },
    ],
  });
  assert.equal(clipState(base, 0), 'ready');
  const trimmed = applyTrackEdit(base, { type: 'trim', anchor: 'a1', end: 2 }, all, { frame: 'frames/f.png' });
  const extended = applyTrackEdit(trimmed, { type: 'then', anchor: 'a1', then: 'extend' }, all);
  assert.equal(extended.anchors[1]!.image, 'frames/f.png');
  assert.equal(clipState(extended, 0), 'ready', 'it ends on its own frame');
  // Putting the made-for end image back asks first, and leaves the trimmed clip out of date.
  assert.deepEqual(clipsTouching(extended, 'a2', 'stills/b.png'), ['a1']);
  const back = applyTrackEdit(extended, { type: 'set-image', anchor: 'a2', file: 'stills/b.png' }, all);
  assert.equal(clipStaleReason(back, 0), 'end');
  assert.deepEqual(exportCheck(back).stale, ['Clip 1→2']);
});

test('resetting a trim that made the next shot\'s image puts the old image back', () => {
  const base = parseStudioTrack({ aspectRatio: '16:9', anchors: [
    { id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: null, use: 'clips/one.mp4', versions: [{ file: 'clips/one.mp4', from: 'stills/a.png', to: null, seconds: 4 }] } },
    { id: 'a2', image: 'stills/b.png' },
  ] });
  const files = { has: () => true, seconds: () => 4 };
  const trimmed = applyTrackEdit(base, { type: 'trim', anchor: 'a1', end: 2 }, files, { frame: 'frames/x.png' });
  const extended = applyTrackEdit(trimmed, { type: 'then', anchor: 'a1', then: 'extend' }, files);
  assert.equal(extended.anchors[1]!.image, 'frames/x.png');
  const reset = applyTrackEdit(extended, { type: 'reset-trim', anchor: 'a1' }, files);
  assert.equal(reset.anchors[1]!.image, 'stills/b.png');
  assert.ok(reset.anchors[1]!.earlier.includes('frames/x.png'), 'the frame stays in the library');
  assert.equal(reset.anchors[0]!.clip!.then, null);
});

test('moving an anchor asks again for the boundaries it touched', () => {
  const track = edit(threeAnchors(), { type: 'move-anchor', anchor: threeAnchors().anchors[2]!.id, to: 0 });
  assert.deepEqual(track.anchors.map((anchor) => anchor.image), ['stills/c.png', 'stills/a.png', 'stills/b.png']);
  assert.equal(track.anchors[0]!.clip!.then, null);
  assert.equal(track.anchors[1]!.clip!.then, 'extend');
  assert.ok(track.anchors[2]!.clip === null || track.anchors[2]!.clip.then === null);
});

test('a clip made for a Cut is out of date once its boundary becomes an Extend, and fits again as a Cut', () => {
  const base = parseStudioTrack({ anchors: [{ id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: 'cut' } }, { id: 'a2', image: 'stills/b.png' }] });
  const delivered = applyStudioDelivery(base, { kind: 'clip', clip: 'c1', file: 'clips/one.mp4', usd: 0.36, model: 'Example' }, 4, 1)!;
  assert.equal(delivered.anchors[0]!.clip!.versions[0]!.to, null);
  assert.equal(clipState(delivered, 0), 'ready');
  // It ends freely, so it doesn't land on the next image an Extend needs.
  const extended = applyTrackEdit(delivered, { type: 'then', anchor: 'a1', then: 'extend' }, all);
  assert.equal(clipState(extended, 0), 'stale');
  assert.equal(clipStaleReason(extended, 0), 'cut');
  assert.equal(clipState(applyTrackEdit(extended, { type: 'then', anchor: 'a1', then: 'cut' }, all), 0), 'ready');
});

test('a clip made for an Extend is out of date once its boundary becomes a Cut, unless it is trimmed', () => {
  const base = parseStudioTrack({ anchors: [{ id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: 'extend' } }, { id: 'a2', image: 'stills/b.png' }] });
  const delivered = applyStudioDelivery(base, { kind: 'clip', clip: 'c1', file: 'clips/one.mp4', usd: 0.36, model: 'Example' }, 4, 1)!;
  assert.equal(delivered.anchors[0]!.clip!.versions[0]!.to, 'stills/b.png');
  // It still drives into the next shot's image, so the Cut would not show: Update remakes it as a Cut.
  const cut = applyTrackEdit(delivered, { type: 'then', anchor: 'a1', then: 'cut' }, all);
  assert.equal(clipState(cut, 0), 'stale');
  assert.equal(clipStaleReason(cut, 0), 'extend');
  assert.deepEqual(exportCheck(cut).stale, ['Clip 1→2']);
  // Back to Extend, it fits again.
  assert.equal(clipState(applyTrackEdit(cut, { type: 'then', anchor: 'a1', then: 'extend' }, all), 0), 'ready');
  // A trimmed one ends where the user chose, not on the next shot's image: it fits a Cut.
  const trimmed = applyTrackEdit(applyTrackEdit(delivered, { type: 'trim', anchor: 'a1', end: 2 }, all, { frame: 'frames/x.png' }), { type: 'then', anchor: 'a1', then: 'cut' }, all);
  assert.equal(clipState(trimmed, 0), 'ready');
});

test('a shot added before the first one starts its scene, keeping the scene\'s name and world, unless it starts its own', () => {
  const named = edit(threeAnchors(), { type: 'scene', anchor: 'a1', name: 'The garden', world: 'Sunny lawn, hot light' });
  const before = edit(named, { type: 'add-anchor', index: 0, title: 'Opening' });
  const runs = sceneRuns(before);
  assert.equal(runs[0]!.anchors[0], before.anchors[0]!.id);
  assert.deepEqual([runs[0]!.name, runs[0]!.world], ['The garden', 'Sunny lawn, hot light']);
  // Choosing Extend into the old first shot keeps them one scene, still named.
  const extended = edit(before, { type: 'then', anchor: before.anchors[0]!.id, then: 'extend' });
  assert.equal(sceneRuns(extended)[0]!.name, 'The garden');
  // A shot that starts a scene of its own leaves the old one its name.
  const own = edit(named, { type: 'add-anchor', index: 0, title: 'Cold open', scene: 'new' });
  assert.equal(own.anchors[0]!.clip!.then, 'cut');
  assert.deepEqual(sceneRuns(own).map((run) => run.name), ['', 'The garden', '']);
});

test('a request the editor never sent is withdrawn, and a later request for the clip is kept', () => {
  const base = edit(threeAnchors(), { type: 'then', anchor: 'a1', then: 'cut' });
  const asked = applyTrackEdit(base, { type: 'request', clips: ['a1'], images: [] }, all, { now: 5 });
  assert.equal(asked.anchors[0]!.clip!.requestedAt, 5);
  const withdrawn = applyTrackEdit(asked, { type: 'withdraw-request', clips: ['a1'], at: 5 }, all);
  assert.equal(withdrawn.anchors[0]!.clip!.requestedAt, null);
  assert.equal(withdrawn.anchors[0]!.clip!.requested, null);
  const later = applyTrackEdit(asked, { type: 'request', clips: ['a1'], images: [] }, all, { now: 9 });
  assert.equal(applyTrackEdit(later, { type: 'withdraw-request', clips: ['a1'], at: 5 }, all).anchors[0]!.clip!.requestedAt, 9);
  // Only the user's editor may withdraw: the agent cannot.
  assert.equal(parseStudioAgentEdit({ edit: { type: 'withdraw-request', clips: ['a1'], at: 5 } }), null);
});

test('asking for a clip needs its Cut or Extend first', () => {
  const base = parseStudioTrack({ anchors: [{ id: 'a1', image: 'stills/a.png', clip: { id: 'c1' } }, { id: 'a2', image: 'stills/b.png' }] });
  assert.throws(() => applyTrackEdit(base, { type: 'request', clips: ['a1'], images: [] }, all), /Choose Cut or Extend after Clip 1→2 first/);
  const decided = applyTrackEdit(base, { type: 'then', anchor: 'a1', then: 'cut' }, all);
  assert.equal(clipState(applyTrackEdit(decided, { type: 'request', clips: ['a1'], images: [] }, all), 0), 'requested');
});

test('putting back the image a clip was made from touches no clip', () => {
  const track = parseStudioTrack({
    anchors: [
      { id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: 'extend', use: 'clips/one.mp4', versions: [{ file: 'clips/one.mp4', from: 'stills/a.png', to: 'stills/b.png' }] } },
      { id: 'a2', image: 'stills/new.png', earlier: ['stills/b.png'], clip: { id: 'c2', use: 'clips/two.mp4', versions: [{ file: 'clips/two.mp4', from: 'stills/b.png' }] } },
      { id: 'a3', image: 'stills/c.png' },
    ],
  });
  assert.deepEqual(clipsTouching(track, 'a2', 'stills/b.png'), []);
  assert.deepEqual(clipsTouching(track, 'a2', 'stills/c.png'), ['a1', 'a2']);
});

test('undo goes back one edit but keeps delivered clips in use, upload names and what was spent', () => {
  const start = parseStudioTrack({
    anchors: [
      { id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: 'cut', use: 'clips/two.mp4', versions: [{ file: 'clips/two.mp4', from: 'stills/a.png' }] } },
      { id: 'a2', image: 'stills/b.png' },
    ],
  });
  const directed = edit(start, { type: 'clip', anchor: 'a1', prompt: 'Faster' });
  const later = applyStudioDelivery(directed, { kind: 'clip', clip: 'c1', file: 'clips/one.mp4', usd: 1.25, model: 'Example' }, 4, 9)!;
  later.labels['uploads/x.png'] = 'x.png';
  const undone = undoTo(start, later);
  assert.equal(undone.anchors[0]!.clip!.prompt, '');
  assert.equal(undone.anchors[0]!.clip!.use, 'clips/one.mp4', 'the paid remake stays in use');
  assert.deepEqual(undone.anchors[0]!.clip!.versions.map((version) => version.file), ['clips/two.mp4', 'clips/one.mp4']);
  assert.deepEqual(undone.spent.map((line) => line.usd), [1.25]);
  assert.equal(undone.labels['uploads/x.png'], 'x.png');
  // A track written to disk and read back replays the same way.
  assert.equal(undoTo(start, parseStudioTrack(JSON.parse(JSON.stringify(later)))).anchors[0]!.clip!.use, 'clips/one.mp4');
});

test('undo refuses to take away a place the agent has since delivered into', () => {
  const start = threeAnchors();
  const added = edit(start, { type: 'add-anchor', index: 3, scene: 'continue' });
  const clipId = added.anchors[2]!.clip!.id;
  const later = applyStudioDelivery(added, { kind: 'clip', clip: clipId, file: 'clips/one.mp4', usd: 0.5, model: 'Example' }, 4, 9)!;
  assert.throws(() => undoTo(start, later), /Undo would take Clip 3→4 off the track/);
});

function makeVideo(file: string, seconds: number, color: string) {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=24`, '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
}

function makeImage(file: string, color: string) {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90`, '-frames:v', '1', file]);
}

function duration(file: string): number {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
}

test('trim, deliveries, undo and export work on real files', async (t) => {
  try { execFileSync('ffmpeg', ['-version']); execFileSync('ffprobe', ['-version']); } catch { t.skip('ffmpeg unavailable'); return; }
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-track-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Harbor', root);
  const dir = path.join(root, id);
  const created = await getStudioProject(id, root);
  assert.deepEqual(created?.track?.anchors, [], 'a new project starts with an empty track');

  const red = path.join(tmp, 'red.png');
  const blue = path.join(tmp, 'blue.png');
  makeImage(red, 'red');
  makeImage(blue, 'blue');
  let { track } = await editStudioTrack(dir, { type: 'import', index: 0 }, { picked: [red, blue] });
  assert.equal((await getStudioProject(id, root))!.canUndo, true, 'the first edit can be undone');
  assert.equal(track.anchors.length, 2);
  assert.equal(track.labels[track.anchors[0]!.image!], 'red.png');
  const [a1, a2] = track.anchors;

  // The agent delivers the clip it was asked for.
  await mkdir(path.join(dir, 'clips'));
  makeVideo(path.join(dir, 'clips/c1-v1.mp4'), 3, 'green');
  await mkdir(path.join(dir, 'deliveries'));
  await writeFile(path.join(dir, 'deliveries/one.json'), JSON.stringify({ clip: a1!.clip!.id, file: 'clips/c1-v1.mp4', usd: 0.36, model: 'Example video model' }));
  await writeFile(path.join(dir, 'deliveries/bad.json'), JSON.stringify({ clip: 'c99', file: 'clips/missing.mp4' }));
  const notices = await ingestStudioDeliveries(dir, 5);
  assert.equal(notices.length, 1);
  assert.equal(notices[0], 'A clip the agent made could not be placed: its file was not found in the project.');
  assert.deepEqual((await readdir(path.join(dir, 'deliveries/done'))), ['5-one.json']);
  let detail = await getStudioProject(id, root);
  track = detail!.track!;
  const clip = track.anchors[0]!.clip!;
  assert.equal(clip.use, 'clips/c1-v1.mp4');
  assert.ok(Math.abs(clip.versions[0]!.seconds! - 3) < 0.1);
  assert.equal(clip.versions[0]!.from, a1!.image);
  assert.deepEqual(track.spent, [{ label: 'Clip 1→2', detail: 'Example video model', usd: 0.36 }]);
  assert.equal(detail!.library.find((item) => item.file === 'clips/c1-v1.mp4')?.status, 'in-use');

  // Export needs a decision for the boundary.
  await assert.rejects(editStudioTrack(dir, { type: 'export' }), /Choose Cut or Extend/);

  // Trim to 2 s, then Extend: the frame at 2 s becomes Shot 2.
  track = (await editStudioTrack(dir, { type: 'trim', anchor: a1!.id, end: 2 })).track;
  const frame = track.anchors[0]!.clip!.endFrame!;
  assert.match(frame, /^frames\/.+\.png$/);
  track = (await editStudioTrack(dir, { type: 'then', anchor: a1!.id, then: 'extend' })).track;
  assert.equal(track.anchors[1]!.image, frame);
  detail = await getStudioProject(id, root);
  assert.equal(detail!.library.find((item) => item.file === a2!.image)?.status, 'earlier', 'the replaced image stays in the library');

  // A delivery with a cost but no place on the track still counts as spent.
  await writeFile(path.join(dir, 'deliveries/lost.json'), JSON.stringify({ clip: 'c77', file: 'clips/c1-v1.mp4', usd: 0.5 }));
  assert.match((await ingestStudioDeliveries(dir, 6))[0]!, /^A clip the agent made could not be placed: its clip is no longer on the storyboard\.$/);
  track = (await getStudioProject(id, root))!.track!;
  assert.deepEqual(track.spent.map((line) => line.label), ['Clip 1→2', 'Not placed: clips/c1-v1.mp4']);

  // Undo puts the old image back, and the decision is asked again.
  track = (await editStudioTrack(dir, { type: 'undo' })).track;
  assert.equal(track.anchors[1]!.image, a2!.image);
  assert.equal(track.anchors[0]!.clip!.then, null);
  track = (await editStudioTrack(dir, { type: 'then', anchor: a1!.id, then: 'cut' })).track;

  const result = await editStudioTrack(dir, { type: 'export' });
  const exported = result.track.exports.at(-1)!;
  assert.ok(Math.abs(duration(path.join(dir, exported)) - 2) < 0.15, 'the export plays the trimmed clip');
  detail = await getStudioProject(id, root);
  assert.equal(detail!.library.find((item) => item.file === exported)?.status, 'export');
  const saved = JSON.parse(await readFile(path.join(dir, 'track.json'), 'utf8')) as StudioTrack;
  assert.equal(saved.anchors.length, 2);
});

test('a storyboard project opens in the track editor with its clips kept as Cuts', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-legacy-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Old', root);
  const dir = path.join(root, id);
    await mkdir(path.join(dir, 'stills'));
  await writeFile(path.join(dir, 'stills/shot-01.png'), 'x');
  await writeFile(path.join(dir, 'stills/shot-02.png'), 'x');
  await writeFile(path.join(dir, 'board.json'), JSON.stringify({ aspectRatio: '9:16', shots: [{ id: '01', title: 'Stairs', still: 'stills/shot-01.png' }, { id: '02', still: 'stills/shot-02.png' }] }));
  const before = await getStudioProject(id, root);
  assert.equal(before!.track, null);
  const { track } = await editStudioTrack(dir, { type: 'convert' }, { board: before!.board });
  assert.equal(track.aspectRatio, '9:16');
  assert.deepEqual(track.anchors.map((anchor) => anchor.image), ['stills/shot-01.png', 'stills/shot-02.png']);
  assert.equal(track.anchors[0]!.clip!.then, 'cut');
  assert.equal(track.scenes[track.anchors[0]!.id]?.name, 'Stairs');
  assert.deepEqual(track.anchors.map((anchor) => anchor.title), ['Stairs', ''], 'shot titles stay on the storyboard');
});

test('the agent may ask only for the edits a user could make in chat', () => {
  assert.deepEqual(parseStudioAgentEdit({ edit: { type: 'title', anchor: 'a2', title: '  Grand theft ladybug ' } }), { type: 'title', anchor: 'a2', title: 'Grand theft ladybug' });
  assert.deepEqual(parseStudioAgentEdit({ edit: { type: 'clip', anchor: 'a1', plannedSeconds: 8 } }), { type: 'clip', anchor: 'a1', plannedSeconds: 8, prompt: undefined });
  assert.equal(parseStudioAgentEdit({ edit: { type: 'then', anchor: 'a1', then: 'maybe' } }), null);
  for (const type of ['undo', 'export', 'trim', 'import', 'convert', 'request', 'set-image', 'add-version', 'dismiss-notices']) {
    assert.equal(parseStudioAgentEdit({ edit: { type, anchor: 'a1', end: 1, file: 'stills/a.png' } }), null, `${type} is the user's alone`);
  }
  assert.equal(parseStudioAgentEdit({ clip: 'c1', file: 'clips/one.mp4' }), null, 'a file delivery is not an edit');
});

test('edits the agent delivers apply in order, each one undoable, and a refused one is set aside', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-agent-edit-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Plan', root);
  const dir = path.join(root, id);
  await mkdir(path.join(dir, 'deliveries'));
  // A new project has no track.json yet: the agent's first shot starts it.
  await writeFile(path.join(dir, 'deliveries', '0-first.json'), JSON.stringify({ edit: { type: 'add-anchor', index: 0 } }));
  assert.deepEqual(await ingestStudioDeliveries(dir, 8), []);
  assert.equal((await getStudioProject(id, root))!.track!.anchors.length, 1);
  const deliver = (name: string, edit: unknown) => writeFile(path.join(dir, 'deliveries', name), JSON.stringify({ edit }));
  await deliver('1-title.json', { type: 'title', anchor: 'a1', title: 'Welcome to Los Antgeles' });
  await deliver('2-add.json', { type: 'add-anchor', index: 1, scene: 'continue', title: 'The hero swaggers in', prompt: 'The hero ant walks in' });
  await deliver('3-length.json', { type: 'clip', anchor: 'a1', plannedSeconds: 8 });
  await deliver('4-too-long.json', { type: 'clip', anchor: 'a1', plannedSeconds: 99 });
  await deliver('5-undo.json', { type: 'undo' });
  await deliver('6-unknown.json', { type: 'title', anchor: 'zz99', title: 'x' });
  const notices = await ingestStudioDeliveries(dir, 9);
  assert.equal(notices.length, 3);
  assert.match(notices[0]!, /^A change the agent asked for could not be made: Choose a length from 1 to 30 seconds\.$/);
  assert.match(notices[1]!, /^A change the agent asked for could not be made: only you can do that, here in the app\.$/);
  assert.match(notices[2]!, /^A change the agent asked for could not be made: the app could not read it\.$/);
  let track = (await getStudioProject(id, root))!.track!;
  assert.deepEqual(track.anchors.map((anchor) => anchor.title), ['Welcome to Los Antgeles', 'The hero swaggers in']);
  assert.equal(track.anchors[1]!.prompt, 'The hero ant walks in');
  assert.equal(track.anchors[0]!.clip!.then, 'extend');
  assert.equal(track.anchors[0]!.clip!.plannedSeconds, 8);
  assert.deepEqual((await readdir(path.join(dir, 'deliveries/done'))).sort(), ['8-0-first.json', '9-1-title.json', '9-2-add.json', '9-3-length.json']);
  track = (await editStudioTrack(dir, { type: 'undo' })).track;
  assert.equal(track.anchors[0]!.clip!.plannedSeconds, 5, 'undo takes back the last edit the agent made');
  assert.equal(track.anchors.length, 2);
});

test('what was spent counts every line, however many retakes a film has', () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => ({ label: `Clip ${String(index + 1)}`, usd: 0.1 }));
  assert.equal(sumStudioCost(parseStudioTrack({ ...emptyStudioTrack(), spent: lines(250) }).spent), 25);
  const board = parseStudioBoard({ spent: lines(70), estimate: { approved: true, lines: lines(70) } });
  assert.equal(sumStudioCost(board.spent), 7);
  assert.equal(board.estimate?.totalUsd, 7);
});

test('a clip keeps the version it plays when it has more versions than the track keeps', () => {
  let track = parseStudioTrack({ anchors: [{ id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: 'cut' } }, { id: 'a2', image: 'stills/b.png' }] });
  const many = { has: () => true, seconds: () => 4 };
  for (let n = 1; n <= 65; n += 1) track = applyTrackEdit(track, { type: 'add-version', anchor: 'a1', file: `clips/take-${String(n)}.mp4` }, many, { now: n });
  const reread = parseStudioTrack(JSON.parse(JSON.stringify(track)));
  const clip = reread.anchors[0]!.clip!;
  assert.equal(clip.use, 'clips/take-65.mp4', 'the newest version stays in use after a save and a read');
  assert.equal(clip.versions.length, 64);
  assert.equal(clip.versions[0]!.file, 'clips/take-2.mp4', 'the oldest version is the one let go');
  // A version in use that is older than the rest stays too.
  const old = parseStudioTrack({ anchors: [{ id: 'a1', image: 'stills/a.png', clip: { id: 'c1', use: 'clips/take-1.mp4', versions: Array.from({ length: 70 }, (_, index) => ({ file: `clips/take-${String(index + 1)}.mp4` })) } }] });
  assert.equal(old.anchors[0]!.clip!.use, 'clips/take-1.mp4');
  assert.equal(old.anchors[0]!.clip!.versions.length, 64);
});

test('switching versions after a trim that extends leaves the next shot\'s frame, and the new version is checked against it', () => {
  const base = parseStudioTrack({ anchors: [
    { id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: null, use: 'clips/one.mp4', versions: [
      { file: 'clips/one.mp4', from: 'stills/a.png', to: null, seconds: 4 },
      { file: 'clips/two.mp4', from: 'stills/a.png', to: null, seconds: 4 },
    ] } },
    { id: 'a2', image: 'stills/b.png' },
  ] });
  const trimmed = applyTrackEdit(base, { type: 'trim', anchor: 'a1', end: 2 }, all, { frame: 'frames/x.png' });
  const extended = applyTrackEdit(trimmed, { type: 'then', anchor: 'a1', then: 'extend' }, all);
  assert.equal(clipState(extended, 0), 'ready', 'the trimmed clip ends on its own frame');
  const switched = applyTrackEdit(extended, { type: 'use-version', anchor: 'a1', file: 'clips/two.mp4' }, all);
  assert.equal(switched.anchors[1]!.image, 'frames/x.png');
  assert.equal(switched.anchors[1]!.from, null, 'the frame no longer belongs to the clip in use');
  assert.equal(clipStaleReason(switched, 0), 'cut', 'the other version was made without an end frame');
  assert.deepEqual(exportCheck(switched).stale, ['Clip 1→2']);
});

test('a clip delivered after its images or boundary changed is out of date, and Undo keeps what it was made from', () => {
  const base = parseStudioTrack({ anchors: [{ id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: 'extend' } }, { id: 'a2', image: 'stills/b.png' }] });
  const clipFile = { kind: 'clip' as const, clip: 'c1', file: 'clips/one.mp4', usd: 0.36, model: 'Example' };
  const asked = edit(base, { type: 'request', clips: ['a1'], images: [] });

  // The start image is replaced while the clip is being made.
  const replaced = edit(asked, { type: 'set-image', anchor: 'a1', file: 'stills/new.png' });
  const late = applyStudioDelivery(replaced, clipFile, 4, 2)!;
  assert.equal(late.anchors[0]!.clip!.versions[0]!.from, 'stills/a.png', 'made from the image it was asked for with');
  assert.equal(late.anchors[0]!.clip!.requested, null);
  assert.equal(clipStaleReason(late, 0), 'image');
  assert.deepEqual(late.delivered[0]!.inputs, { from: 'stills/a.png', to: 'stills/b.png' });

  // The image it lands on is replaced.
  const landing = applyStudioDelivery(edit(asked, { type: 'set-image', anchor: 'a2', file: 'stills/new.png' }), clipFile, 4, 2)!;
  assert.equal(clipStaleReason(landing, 0), 'end');

  // Asked for as a Cut, then made an Extend.
  const cutAsked = edit(edit(base, { type: 'then', anchor: 'a1', then: 'cut' }), { type: 'request', clips: ['a1'], images: [] });
  const nowExtend = applyStudioDelivery(edit(cutAsked, { type: 'then', anchor: 'a1', then: 'extend' }), clipFile, 4, 2)!;
  assert.equal(clipStaleReason(nowExtend, 0), 'cut');

  // Undoing the image change puts back the image the clip was made from: it fits again.
  const undone = undoTo(parseStudioTrack(JSON.parse(JSON.stringify(asked))), parseStudioTrack(JSON.parse(JSON.stringify(late))));
  assert.equal(undone.anchors[0]!.image, 'stills/a.png');
  assert.equal(undone.anchors[0]!.clip!.use, 'clips/one.mp4');
  assert.equal(clipState(undone, 0), 'ready');

  // A clip nobody asked for in the editor is taken as made from the images the track has.
  const unasked = applyStudioDelivery(base, clipFile, 4, 2)!;
  assert.equal(clipState(unasked, 0), 'ready');
});

test('a delivery stays in the inbox until the track it changed is saved', async (t) => {
  if (process.getuid?.() === 0) { t.skip('root ignores folder permissions'); return; }
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-ingest-save-'));
  t.after(async () => { await chmod(dir, 0o755).catch(() => {}); await rm(tmp, { recursive: true, force: true }); });
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Save first', root);
  const dir = path.join(root, id);
  await editStudioTrack(dir, { type: 'add-anchor', index: 0 });
  await mkdir(path.join(dir, 'stills'));
  await writeFile(path.join(dir, 'stills/a.png'), 'x');
  await mkdir(path.join(dir, 'deliveries/done'), { recursive: true });
  await writeFile(path.join(dir, 'deliveries/image.json'), JSON.stringify({ anchor: 'a1', file: 'stills/a.png', usd: 0.04, model: 'Example image model' }));
  // The project folder refuses the track write; the inbox stays writable.
  await chmod(dir, 0o555);
  await assert.rejects(ingestStudioDeliveries(dir, 7));
  assert.deepEqual(await readdir(path.join(dir, 'deliveries/done')), [], 'nothing was archived');
  assert.deepEqual((await readdir(path.join(dir, 'deliveries'))).sort(), ['done', 'image.json']);
  // Once the track can be saved, the same delivery goes in.
  await chmod(dir, 0o755);
  assert.deepEqual(await ingestStudioDeliveries(dir, 8), []);
  const track = (await getStudioProject(id, root))!.track!;
  assert.equal(track.anchors[0]!.image, 'stills/a.png');
  assert.equal(sumStudioCost(track.spent), 0.04);
  assert.deepEqual(await readdir(path.join(dir, 'deliveries/done')), ['8-image.json']);
});

test('without ffmpeg and ffprobe, trim says why and a library clip still goes in without its length', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-no-tools-'));
  const emptyBin = path.join(tmp, 'bin');
  await mkdir(emptyBin);
  const savedPath = process.env['PATH'];
  process.env['PATH'] = emptyBin;
  t.after(async () => { process.env['PATH'] = savedPath; await rm(tmp, { recursive: true, force: true }); });
  assert.equal(await detectStudioMediaTools(), false);
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('No tools', root);
  const dir = path.join(root, id);
  await mkdir(path.join(dir, 'clips'));
  await writeFile(path.join(dir, 'clips/one.mp4'), 'not really a video');
  await editStudioTrack(dir, { type: 'add-anchor', index: 0 });
  await editStudioTrack(dir, { type: 'add-anchor', index: 1, scene: 'new' });
  const { track } = await editStudioTrack(dir, { type: 'add-version', anchor: 'a1', file: 'clips/one.mp4' });
  assert.equal(track.anchors[0]!.clip!.use, 'clips/one.mp4');
  assert.equal(track.anchors[0]!.clip!.versions[0]!.seconds, null, 'its length is unknown without ffprobe');
  await assert.rejects(editStudioTrack(dir, { type: 'trim', anchor: 'a1', end: 1 }), (error: Error) => error.message === STUDIO_MEDIA_TOOLS_MISSING);
  await assert.rejects(editStudioTrack(dir, { type: 'export' }), (error: Error) => error.message === STUDIO_MEDIA_TOOLS_MISSING);
});

test('resetting an end after several trims that extend puts back the image from before the first', () => {
  const base = parseStudioTrack({ aspectRatio: '16:9', anchors: [
    { id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: null, use: 'clips/one.mp4', versions: [{ file: 'clips/one.mp4', from: 'stills/a.png', to: null, seconds: 4 }] } },
    { id: 'a2', image: 'stills/b.png' },
  ] });
  const files = { has: () => true, seconds: () => 4 };
  const trimAndExtend = (track: StudioTrack, end: number, frame: string) =>
    applyTrackEdit(applyTrackEdit(track, { type: 'trim', anchor: 'a1', end }, files, { frame }), { type: 'then', anchor: 'a1', then: 'extend' }, files);
  const twice = trimAndExtend(trimAndExtend(base, 3, 'frames/f1.png'), 2, 'frames/f2.png');
  assert.equal(twice.anchors[1]!.image, 'frames/f2.png');
  const reset = applyTrackEdit(twice, { type: 'reset-trim', anchor: 'a1' }, files);
  assert.equal(reset.anchors[1]!.image, 'stills/b.png', 'the image the shot had before any frame of this clip');
  assert.equal(reset.anchors[1]!.from, null);
  assert.ok(reset.anchors[1]!.earlier.includes('frames/f1.png') && reset.anchors[1]!.earlier.includes('frames/f2.png'), 'both frames stay in the library');
  // The kept image survives a save and a read.
  const reread = parseStudioTrack(JSON.parse(JSON.stringify(twice)));
  assert.equal(applyTrackEdit(reread, { type: 'reset-trim', anchor: 'a1' }, files).anchors[1]!.image, 'stills/b.png');
});

test('resetting an end that extended into a shot without an image leaves it without one', () => {
  const base = parseStudioTrack({ aspectRatio: '16:9', anchors: [
    { id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: null, use: 'clips/one.mp4', versions: [{ file: 'clips/one.mp4', from: 'stills/a.png', to: null, seconds: 4 }] } },
    { id: 'a2', image: null, earlier: ['stills/old.png'] },
  ] });
  const files = { has: () => true, seconds: () => 4 };
  const extended = applyTrackEdit(applyTrackEdit(base, { type: 'trim', anchor: 'a1', end: 2 }, files, { frame: 'frames/x.png' }), { type: 'then', anchor: 'a1', then: 'extend' }, files);
  assert.equal(extended.anchors[1]!.image, 'frames/x.png');
  const reset = applyTrackEdit(extended, { type: 'reset-trim', anchor: 'a1' }, files);
  assert.equal(reset.anchors[1]!.image, null, 'not an older image from its library');
  assert.equal(reset.anchors[1]!.from, null);
  assert.ok(reset.anchors[1]!.earlier.includes('frames/x.png'));
});

test('a video longer than ten minutes keeps its length and a trim past ten minutes through a save and a read', () => {
  const base = parseStudioTrack({ anchors: [
    { id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: null } },
    { id: 'a2', image: 'stills/b.png' },
  ] });
  const long = { has: () => true, seconds: () => 900 };
  const added = applyTrackEdit(base, { type: 'add-version', anchor: 'a1', file: 'uploads/long.mp4' }, long);
  const trimmed = applyTrackEdit(added, { type: 'trim', anchor: 'a1', end: 700 }, long, { frame: 'frames/x.png' });
  const extended = applyTrackEdit(trimmed, { type: 'then', anchor: 'a1', then: 'extend' }, long);
  const reread = parseStudioTrack(JSON.parse(JSON.stringify(extended)));
  const clip = reread.anchors[0]!.clip!;
  assert.equal(clip.versions[0]!.seconds, 900);
  assert.equal(clip.end, 700, 'the trim the editor took is the one the export uses');
  assert.equal(clip.endFrame, 'frames/x.png');
  assert.equal(reread.anchors[1]!.from?.at, 700);
  assert.equal(clipState(reread, 0), 'ready');
});

test('a clip asked for in chat and delivered after its start image changed is out of date', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-chat-clip-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Chat clip', root);
  const dir = path.join(root, id);
  await mkdir(path.join(dir, 'stills'));
  await mkdir(path.join(dir, 'clips'));
  for (const file of ['stills/a.png', 'stills/b.png', 'stills/new.png']) await writeFile(path.join(dir, file), 'x');
  await writeFile(path.join(dir, 'clips/one.mp4'), 'x');
  await editStudioTrack(dir, { type: 'add-anchor', index: 0, file: 'stills/a.png' });
  await editStudioTrack(dir, { type: 'add-anchor', index: 1, file: 'stills/b.png', scene: 'new' });
  // The user asked in chat, not with Update, so the editor recorded no request; then replaced the start image.
  const clipId = (await editStudioTrack(dir, { type: 'set-image', anchor: 'a1', file: 'stills/new.png' })).track.anchors[0]!.clip!.id;
  await mkdir(path.join(dir, 'deliveries'));
  await writeFile(path.join(dir, 'deliveries/clip.json'), JSON.stringify({ clip: clipId, file: 'clips/one.mp4', usd: 0.36, model: 'Example video model', startFrame: 'stills/a.png', endFrame: null }));
  assert.deepEqual(await ingestStudioDeliveries(dir, 5), []);
  const track = (await getStudioProject(id, root))!.track!;
  assert.equal(track.anchors[0]!.clip!.use, 'clips/one.mp4');
  assert.equal(track.anchors[0]!.clip!.versions[0]!.from, 'stills/a.png', 'made from the image the agent used');
  assert.equal(clipStaleReason(track, 0), 'image');
  assert.equal(track.delivered[0]!.delivery.kind === 'clip' ? track.delivered[0]!.delivery.startFrame : null, 'stills/a.png');
});

test('an edit the agent delivers stays in the inbox when the track cannot be saved, and goes in once it can', async (t) => {
  if (process.getuid?.() === 0) { t.skip('root ignores folder permissions'); return; }
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-edit-save-'));
  t.after(async () => { await chmod(dir, 0o755).catch(() => {}); await rm(tmp, { recursive: true, force: true }); });
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Edit save', root);
  const dir = path.join(root, id);
  await editStudioTrack(dir, { type: 'add-anchor', index: 0 });
  await mkdir(path.join(dir, 'deliveries/failed'), { recursive: true });
  await mkdir(path.join(dir, 'deliveries/done'));
  await writeFile(path.join(dir, 'deliveries/title.json'), JSON.stringify({ edit: { type: 'title', anchor: 'a1', title: 'The chase' } }));
  // The project folder refuses the track write; the inbox stays writable.
  await chmod(dir, 0o555);
  await assert.rejects(ingestStudioDeliveries(dir, 7));
  assert.deepEqual(await readdir(path.join(dir, 'deliveries/failed')), [], 'a failed save is not a refused edit');
  assert.ok((await readdir(path.join(dir, 'deliveries'))).includes('title.json'));
  await chmod(dir, 0o755);
  assert.deepEqual(await ingestStudioDeliveries(dir, 8), []);
  assert.equal((await getStudioProject(id, root))!.track!.anchors[0]!.title, 'The chase');
  assert.deepEqual(await readdir(path.join(dir, 'deliveries/done')), ['8-title.json']);
});

test('a delivery saved to the track but not moved out of the inbox is not applied again', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-ingest-twice-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Twice', root);
  const dir = path.join(root, id);
  await editStudioTrack(dir, { type: 'add-anchor', index: 0 });
  await mkdir(path.join(dir, 'stills'));
  await writeFile(path.join(dir, 'stills/a.png'), 'x');
  await mkdir(path.join(dir, 'deliveries'));
  // A file where the archive folder goes: the track saves, the move fails.
  const blockArchive = () => writeFile(path.join(dir, 'deliveries/done'), 'not a folder');
  const unblockArchive = () => rm(path.join(dir, 'deliveries/done'));
  const historyLength = async () => JSON.parse(await readFile(path.join(dir, 'track.history.json'), 'utf8')).length as number;

  // A file delivery with a price.
  await writeFile(path.join(dir, 'deliveries/image.json'), JSON.stringify({ anchor: 'a1', file: 'stills/a.png', usd: 0.04, model: 'Example image model' }));
  await blockArchive();
  await assert.rejects(ingestStudioDeliveries(dir, 7));
  let track = (await getStudioProject(id, root))!.track!;
  assert.equal(track.anchors[0]!.image, 'stills/a.png', 'saved before the move');
  await unblockArchive();
  assert.deepEqual(await ingestStudioDeliveries(dir, 8), []);
  track = (await getStudioProject(id, root))!.track!;
  assert.equal(sumStudioCost(track.spent), 0.04, 'spent once');
  assert.equal(track.delivered.length, 1);
  assert.deepEqual(await readdir(path.join(dir, 'deliveries/done')), ['8-image.json']);

  // An edit the agent delivers.
  const history = await historyLength();
  await writeFile(path.join(dir, 'deliveries/add.json'), JSON.stringify({ edit: { type: 'add-anchor', index: 1, scene: 'new' } }));
  await rm(path.join(dir, 'deliveries/done'), { recursive: true });
  await blockArchive();
  await assert.rejects(ingestStudioDeliveries(dir, 9));
  assert.equal((await getStudioProject(id, root))!.track!.anchors.length, 2);
  await unblockArchive();
  assert.deepEqual(await ingestStudioDeliveries(dir, 10), []);
  track = (await getStudioProject(id, root))!.track!;
  assert.equal(track.anchors.length, 2, 'one anchor added, not two');
  assert.equal(await historyLength(), history + 1, 'one undo step');
  assert.ok(await studioCanUndo(dir));
  assert.deepEqual(await readdir(path.join(dir, 'deliveries/done')), ['10-add.json']);

  // The same name written again later is a new delivery.
  await writeFile(path.join(dir, 'deliveries/add.json'), JSON.stringify({ edit: { type: 'add-anchor', index: 2, scene: 'new' } }));
  assert.deepEqual(await ingestStudioDeliveries(dir, 11), []);
  assert.equal((await getStudioProject(id, root))!.track!.anchors.length, 3);
});

test('extending a trimmed last clip on a full track is refused, and an accepted one survives a read', () => {
  const trackOf = (count: number) => parseStudioTrack({
    anchors: Array.from({ length: count }, (_, index) => ({
      id: `a${String(index + 1)}`,
      image: 'stills/a.png',
      clip: index === count - 1
        ? { id: `c${String(index + 1)}`, use: 'clips/one.mp4', end: 2, endFrame: 'stills/new.png', versions: [{ file: 'clips/one.mp4', from: 'stills/a.png', seconds: 4 }] }
        : { id: `c${String(index + 1)}`, then: 'cut' },
    })),
  });
  const full = trackOf(120);
  assert.equal(full.anchors.length, 120);
  assert.throws(() => applyTrackEdit(full, { type: 'then', anchor: 'a120', then: 'extend' }, all), /The track is full\./);
  const extended = applyTrackEdit(trackOf(119), { type: 'then', anchor: 'a119', then: 'extend' }, all);
  assert.equal(extended.anchors.length, 120);
  assert.deepEqual(parseStudioTrack(JSON.parse(JSON.stringify(extended))), extended, 'nothing is dropped on the next read');
});

test('a long undo history of a large track keeps its newest steps within the size a read takes', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-history-size-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Large', root);
  const dir = path.join(root, id);
  // A full track with the longest prompts: about half a megabyte a snapshot, under the 2 MiB a track may take.
  const long = 'x'.repeat(2000);
  const track = parseStudioTrack({
    anchors: Array.from({ length: 120 }, (_, index) => ({
      id: `a${String(index + 1)}`,
      prompt: long,
      clip: index < 119 ? { id: `c${String(index + 1)}`, prompt: long } : undefined,
    })),
  });
  await writeFile(path.join(dir, 'track.json'), JSON.stringify(track, null, 2));
  const edits = 24;
  for (let step = 1; step <= edits; step += 1) {
    await editStudioTrack(dir, { type: 'title', anchor: 'a1', title: `Take ${String(step)}` });
  }
  const saved = await readFile(path.join(dir, 'track.history.json'));
  assert.ok(saved.length <= 8 * 1024 * 1024, 'the saved history is no larger than a read takes');
  assert.equal(await studioCanUndo(dir), true);
  for (let step = edits - 1; step >= edits - 10; step -= 1) {
    const undone = await editStudioTrack(dir, { type: 'undo' });
    assert.equal(undone.track.anchors[0]!.title, `Take ${String(step)}`);
  }
});

/** What a save and the next read make of a track. */
const reread = (track: StudioTrack) => parseStudioTrack(JSON.parse(JSON.stringify(track)));

test('a converted storyboard reads back as it was converted: costs above $10,000, long titles and its style line', () => {
  const board = parseStudioBoard({
    style: 's'.repeat(600),
    shots: [{ id: '01', title: 't'.repeat(200), still: 'stills/a.png' }, { id: '02', still: 'stills/b.png' }],
    spent: [{ label: 'Feature film', usd: 12_500 }, { label: 'Retake', usd: 0.5 }],
  });
  const track = trackFromBoard(board, all, 1);
  assert.equal(sumStudioCost(reread(track).spent), 12_500.5, 'every cost the storyboard kept stays spent');
  assert.deepEqual(reread(track), track, 'nothing is dropped or cut on the next read');
});

test('a shot keeps its newest earlier images after more replacements than it keeps, through a save and a read', () => {
  const many = { has: () => true };
  let track = parseStudioTrack({ anchors: [{ id: 'a1', image: 'stills/take-0.png' }] });
  for (let n = 1; n <= 66; n += 1) track = applyTrackEdit(track, { type: 'set-image', anchor: 'a1', file: `stills/take-${String(n)}.png` }, many);
  const earlier = reread(track).anchors[0]!.earlier;
  assert.equal(earlier.length, 64);
  assert.equal(earlier.at(-1), 'stills/take-65.png', 'the image just replaced is kept');
  assert.equal(earlier[0], 'stills/take-2.png', 'the oldest ones are let go');
  assert.deepEqual(reread(track), track, 'the edit keeps what a read keeps');
  // Undo puts back the images the shot had since, within the same limit.
  const undone = undoTo(parseStudioTrack({ anchors: [{ id: 'a1', image: 'stills/first.png' }] }), track);
  assert.equal(undone.anchors[0]!.earlier.length, 64);
  assert.equal(undone.anchors[0]!.earlier.at(-1), 'stills/take-66.png');
  assert.deepEqual(reread(undone), undone);
});

test('values an edit or a delivery writes come back the same from a read', () => {
  const long = `clips/${'n'.repeat(280)}.mp4`;
  const base = parseStudioTrack({ anchors: [{ id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: 'cut' } }, { id: 'a2', image: 'stills/b.png' }] });
  // A delivery's key holds its file, whose path may take 300 characters: Undo matches deliveries by key.
  const delivered = applyStudioDelivery(base, { kind: 'clip', clip: 'c1', file: long, usd: 0.2, model: 'Example video model' }, 4, 7)!;
  assert.deepEqual(reread(delivered).delivered, delivered.delivered);
  // A version from the library is labelled with its upload's name, which may be longer than a label takes.
  const named = { ...base, labels: { 'uploads/x.mp4': 'u'.repeat(200) } };
  const added = applyTrackEdit(named, { type: 'add-version', anchor: 'a1', file: 'uploads/x.mp4' }, { has: () => true });
  assert.deepEqual(reread(added), added);
  // Exports beyond the ones a read lists go, oldest first.
  let exported = base;
  for (let n = 1; n <= 51; n += 1) exported = addStudioExport(exported, `exports/film-${String(n)}.mp4`);
  assert.equal(exported.exports.length, 50);
  assert.equal(exported.exports[0], 'exports/film-2.mp4');
  assert.deepEqual(reread(exported), exported);
});

test('ids stop at six digits: an edit that needs a longer one is refused', () => {
  const track = applyTrackEdit({ ...emptyStudioTrack(), nextId: 999_999 }, { type: 'add-anchor', index: 0 }, all);
  assert.equal(track.anchors[0]!.id, 'a999999');
  assert.deepEqual(reread(track), track);
  assert.throws(() => applyTrackEdit(track, { type: 'add-anchor', index: 1 }, all), /The track is full\./);
});

const MAX_TRACK_BYTES = 2 * 1024 * 1024;
const trackBytes = (track: StudioTrack) => Buffer.byteLength(`${JSON.stringify(track, null, 2)}\n`);

/** Writes a track.json `room` bytes short of the size a read takes: one shot without an image, padded with upload names. */
async function nearlyFullTrack(dir: string, room: number): Promise<Buffer> {
  const padded = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`pad/${String(index).padStart(5, '0')}.png`, 'x'.repeat(200)]));
  const sized = (count: number) => trackBytes(parseStudioTrack({ anchors: [{ id: 'a1' }], labels: padded(count) }));
  const entry = sized(2) - sized(1);
  const labels = padded(Math.floor((MAX_TRACK_BYTES - room - 1000 - sized(0)) / entry));
  const make = (prompt: string) => parseStudioTrack({ anchors: [{ id: 'a1', prompt }], labels });
  const track = make('y'.repeat(MAX_TRACK_BYTES - room - trackBytes(make(''))));
  assert.equal(trackBytes(track), MAX_TRACK_BYTES - room);
  const content = Buffer.from(`${JSON.stringify(track, null, 2)}\n`);
  await writeFile(path.join(dir, 'track.json'), content);
  return content;
}

test('an edit that would grow the track past what a read takes is refused, and the track stays readable', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-track-size-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Full', root);
  const dir = path.join(root, id);
  const before = await nearlyFullTrack(dir, 50);
  await assert.rejects(editStudioTrack(dir, { type: 'title', anchor: 'a1', title: 'T'.repeat(120) }), { message: STUDIO_TRACK_TOO_LARGE });
  assert.deepEqual(await readFile(path.join(dir, 'track.json')), before, 'track.json is untouched');
  assert.equal(await studioCanUndo(dir), false, 'no undo step was saved for it');
  assert.equal((await readStudioTrack(dir))!.anchors[0]!.title, '');
  // A change that fits still goes in.
  const { track } = await editStudioTrack(dir, { type: 'title', anchor: 'a1', title: 'Short' });
  assert.equal((await readStudioTrack(dir))!.anchors[0]!.title, track.anchors[0]!.title);
});

test('a delivery that would grow the track past what a read takes is set aside, and the track stays readable', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-ingest-size-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Full inbox', root);
  const dir = path.join(root, id);
  const before = await nearlyFullTrack(dir, 100);
  await mkdir(path.join(dir, 'stills'));
  await writeFile(path.join(dir, 'stills/a.png'), 'x');
  await mkdir(path.join(dir, 'deliveries'));
  await writeFile(path.join(dir, 'deliveries/image.json'), JSON.stringify({ anchor: 'a1', file: 'stills/a.png', usd: 0.04, model: 'Example image model' }));
  const notices = await ingestStudioDeliveries(dir, 9);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /^The image for Shot 1 could not be placed: the project would grow larger than the app can open\.$/);
  assert.deepEqual(await readFile(path.join(dir, 'track.json')), before, 'track.json is untouched');
  assert.equal((await readStudioTrack(dir))!.anchors[0]!.image, null);
  assert.deepEqual(await readdir(path.join(dir, 'deliveries/failed')), ['9-image.json']);
});

test('a file the scan does not reach is still found when a delivery or an edit names it, but never one outside the project', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-deep-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Deep files', root);
  const dir = path.join(root, id);
  await editStudioTrack(dir, { type: 'add-anchor', index: 0 });
  await editStudioTrack(dir, { type: 'add-anchor', index: 1 });
  // Five folders deep: past where the library scan stops.
  const deep = 'stills/one/two/three/four/a.png';
  await mkdir(path.join(dir, path.dirname(deep)), { recursive: true });
  await writeFile(path.join(dir, deep), 'x');
  await mkdir(path.join(dir, 'deliveries'), { recursive: true });
  await writeFile(path.join(dir, 'deliveries/image.json'), JSON.stringify({ anchor: 'a1', file: deep, usd: 0.04, model: 'Example image model' }));
  assert.deepEqual(await ingestStudioDeliveries(dir, 7), []);
  assert.equal((await readStudioTrack(dir))!.anchors[0]!.image, deep);
  // An edit naming it works too, and the track still reads it once the delivery is done.
  const { track } = await editStudioTrack(dir, { type: 'set-image', anchor: 'a2', file: deep });
  assert.equal(track.anchors[1]!.image, deep);
  // The project's library lists it, with a version for its address, though the scan never reached it.
  const detail = (await getStudioProject(id, root))!;
  assert.ok(detail.library.some((item) => item.file === deep));
  assert.equal(typeof detail.files[deep], 'number');
  // Only under its own name: another spelling is not the same file, even where the folder ignores case.
  await assert.rejects(editStudioTrack(dir, { type: 'set-image', anchor: 'a2', file: deep.replace('a.png', 'A.png') }));
  // A link that leads outside the project folder is not a project file.
  const outside = path.join(tmp, 'outside.png');
  await writeFile(outside, 'x');
  await symlink(outside, path.join(dir, 'stills/one/two/three/four/escape.png'));
  await assert.rejects(editStudioTrack(dir, { type: 'set-image', anchor: 'a2', file: 'stills/one/two/three/four/escape.png' }));
});

test('a file delivered to a storyboard not yet opened in the editor waits in the inbox, then goes in once it is', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-board-wait-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Old storyboard', root);
  const dir = path.join(root, id);
  await mkdir(path.join(dir, 'stills'));
  await writeFile(path.join(dir, 'stills/a.png'), 'x');
  await writeFile(path.join(dir, 'board.json'), JSON.stringify({ aspectRatio: '16:9', shots: [{ title: 'Harbor', still: 'stills/a.png' }, { title: 'Pier' }] }));
  await mkdir(path.join(dir, 'deliveries'), { recursive: true });
  await writeFile(path.join(dir, 'stills/b.png'), 'x');
  await writeFile(path.join(dir, 'deliveries/image.json'), JSON.stringify({ anchor: 'a1', file: 'stills/b.png', usd: 0.04, model: 'Example image model' }));
  assert.deepEqual(await ingestStudioDeliveries(dir, 7), []);
  assert.ok((await readdir(path.join(dir, 'deliveries'))).includes('image.json'), 'it waits in the inbox');
  const board = (await getStudioProject(id, root))!.board;
  await editStudioTrack(dir, { type: 'convert' }, { board });
  assert.deepEqual(await ingestStudioDeliveries(dir, 8), []);
  const track = (await readStudioTrack(dir))!;
  assert.equal(track.anchors[0]!.image, 'stills/b.png');
  assert.equal(sumStudioCost(track.spent), 0.04);
});

test('an image delivered under a wrong name is not counted, so delivering it again under its own name counts it once', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-wrong-name-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Wrong name', root);
  const dir = path.join(root, id);
  await editStudioTrack(dir, { type: 'add-anchor', index: 0, title: 'Anthill' });
  await mkdir(path.join(dir, 'stills'));
  await writeFile(path.join(dir, 'stills/a1.jpg'), 'x');
  await mkdir(path.join(dir, 'deliveries'));
  // Saved as .jpg, delivered as .png.
  await writeFile(path.join(dir, 'deliveries/img.json'), JSON.stringify({ anchor: 'a1', file: 'stills/a1.png', usd: 0.0165, model: 'Example image model' }));
  const notices = await ingestStudioDeliveries(dir, 7);
  // The user reads which shot and why, never a path.
  assert.deepEqual(notices, ['The image for Shot 1 could not be placed: its file was not found in the project.']);
  assert.equal(sumStudioCost((await readStudioTrack(dir))!.spent), 0);
  await writeFile(path.join(dir, 'deliveries/img-again.json'), JSON.stringify({ anchor: 'a1', file: 'stills/a1.jpg', usd: 0.0165, model: 'Example image model' }));
  assert.deepEqual(await ingestStudioDeliveries(dir, 8), []);
  const track = (await readStudioTrack(dir))!;
  assert.equal(track.anchors[0]!.image, 'stills/a1.jpg');
  assert.equal(sumStudioCost(track.spent), 0.0165);
});

test('Undo keeps each delivery read together, even two of the same file around an edit it takes back', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'studio-same-file-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'studio');
  await mkdir(root);
  const { id } = await createStudioProject('Same file', root);
  const dir = path.join(root, id);
  await editStudioTrack(dir, { type: 'add-anchor', index: 0, title: 'Anthill' });
  const [first, second] = (await editStudioTrack(dir, { type: 'add-anchor', index: 1, scene: 'continue', title: 'Tunnel' })).track.anchors.map((anchor) => anchor.id);
  await mkdir(path.join(dir, 'stills'));
  await writeFile(path.join(dir, 'stills/x.png'), 'x');
  await mkdir(path.join(dir, 'deliveries'));
  // One read takes all three: the same image for both shots, with an edit the user can undo between them.
  await writeFile(path.join(dir, 'deliveries/1-img.json'), JSON.stringify({ anchor: first, file: 'stills/x.png', usd: null, model: 'Example image model' }));
  await writeFile(path.join(dir, 'deliveries/2-edit.json'), JSON.stringify({ edit: { type: 'title', anchor: first, title: 'The Anthill' } }));
  await writeFile(path.join(dir, 'deliveries/3-img.json'), JSON.stringify({ anchor: second, file: 'stills/x.png', usd: null, model: 'Example image model' }));
  assert.deepEqual(await ingestStudioDeliveries(dir, 9), []);
  const track = (await editStudioTrack(dir, { type: 'undo' })).track;
  assert.equal(track.anchors[0]!.title, 'Anthill', 'undo takes back the edit');
  assert.deepEqual(track.anchors.map((anchor) => anchor.image), ['stills/x.png', 'stills/x.png'], 'and keeps both images delivered');
});
