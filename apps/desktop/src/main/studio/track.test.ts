import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
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
  type StudioTrack,
  type TrackEdit,
} from '../../shared/studio-track.js';
import { parseStudioBoard, sumStudioCost } from '../../shared/studio.js';
import { createStudioProject, getStudioProject } from './store.js';
import { editStudioTrack, ingestStudioDeliveries } from './track.js';

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
  assert.deepEqual(extended.anchors[1]!.from, { clip: 'c1', at: 2.5 });
  assert.deepEqual(extended.anchors[1]!.earlier, ['stills/b.png']);
  assert.equal(clipState(extended, 0), 'ready', 'the trimmed clip ends on its own frame');
  assert.equal(clipState(extended, 1), 'stale', 'the next clip started from the old image');
  // The last clip is open: extending its trimmed end adds an anchor after it.
  const open = applyTrackEdit(applyTrackEdit(base, { type: 'trim', anchor: 'a2', end: 1 }, all, { frame: 'frames/y.png' }), { type: 'then', anchor: 'a2', then: 'extend' }, all);
  assert.equal(open.anchors.length, 3);
  assert.equal(open.anchors[2]!.image, 'frames/y.png');
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

test('a clip made for an Extend still fits when its boundary becomes a Cut', () => {
  const base = parseStudioTrack({ anchors: [{ id: 'a1', image: 'stills/a.png', clip: { id: 'c1', then: 'extend' } }, { id: 'a2', image: 'stills/b.png' }] });
  const delivered = applyStudioDelivery(base, { kind: 'clip', clip: 'c1', file: 'clips/one.mp4', usd: 0.36, model: 'Example' }, 4, 1)!;
  assert.equal(delivered.anchors[0]!.clip!.versions[0]!.to, 'stills/b.png');
  // It plays to its end and the film cuts after it: nothing to remake.
  const cut = applyTrackEdit(delivered, { type: 'then', anchor: 'a1', then: 'cut' }, all);
  assert.equal(clipState(cut, 0), 'ready');
  assert.equal(clipStaleReason(cut, 0), null);
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
  assert.match(notices[0]!, /bad\.json/);
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
  assert.match((await ingestStudioDeliveries(dir, 6))[0]!, /clip c77, which is no longer on the track/);
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
  assert.match(notices[0]!, /4-too-long\.json asks for an edit the track refused \(Choose a length from 1 to 30 seconds\.\)/);
  assert.match(notices[1]!, /5-undo\.json asks for "undo", which only the user can do in the app/);
  assert.match(notices[2]!, /6-unknown\.json names anchor "zz99", which is not an anchor id from track\.json/);
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
