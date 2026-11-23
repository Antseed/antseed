import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeStudioPath, parseStudioBoard } from '../../shared/studio.js';
import {
  createStudioProject,
  getStudioProject,
  listStudioProjects,
  resolveStudioFile,
  setStudioProjectConversation,
  slugifyStudioName,
  studioProjectIdForFolder,
} from './store.js';

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-studio-'));
  try {
    await fn(path.join(dir, 'studio'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('normalizeStudioPath keeps paths inside the project', () => {
  assert.equal(normalizeStudioPath('stills/shot-01.png'), 'stills/shot-01.png');
  for (const bad of ['', '/etc/passwd', '../a.png', 'stills/../../a.png', 'stills//a.png', './a.png', 'C:/a.png', 'stills\\a.png', 'a\0.png', 7, null]) {
    assert.equal(normalizeStudioPath(bad), null, String(bad));
  }
});

test('parseStudioBoard keeps what the screen shows and drops the rest', () => {
  const board = parseStudioBoard({
    kind: 'film',
    brief: '  A keeper lights the lamp.  ',
    aspectRatio: '16:9',
    shots: [
      { id: '01', title: 'Stairs', status: 'still', still: 'stills/shot-01.png', clip: '../outside.mp4', durationSeconds: 5 },
      { title: 'No id', status: 'exploded', still: 'stills/notes.txt', durationSeconds: -3 },
      'not a shot',
    ],
    estimate: { approved: 'yes', totalUsd: 99, lines: [{ label: 'Stills', detail: '2 pictures', usd: 0.08 }, { label: 'Bad', usd: -1 }, { usd: 3 }] },
    spent: [{ label: 'Still 01', usd: '0.04' }],
    final: 'final.png',
    models: { video: 'ignored' },
  });
  assert.equal(board.brief, 'A keeper lights the lamp.');
  assert.equal(board.kind, 'video');
  assert.deepEqual(board.shots, [
    { id: '01', title: 'Stairs', description: '', durationSeconds: 5, status: 'still', still: 'stills/shot-01.png', clip: null, note: '' },
    { id: '02', title: 'No id', description: '', durationSeconds: null, status: 'planned', still: null, clip: null, note: '' },
  ]);
  assert.deepEqual(board.estimate, { approved: false, lines: [{ label: 'Stills', detail: '2 pictures', usd: 0.08 }], totalUsd: 0.08 });
  assert.deepEqual(parseStudioBoard({ estimate: { approved: true, totalUsd: 4.5 } }).estimate, { approved: true, lines: [], totalUsd: 4.5 });
  assert.equal(parseStudioBoard({ estimate: { approved: true } }).estimate, null);
  assert.deepEqual(board.spent, [{ label: 'Still 01', detail: '', usd: 0.04 }]);
  assert.equal(board.final, null);
  assert.deepEqual(parseStudioBoard('nonsense').shots, []);
});

test('slugifyStudioName makes a folder name', () => {
  assert.equal(slugifyStudioName('  Lighthouse: in a Storm!  '), 'lighthouse-in-a-storm');
  assert.equal(slugifyStudioName('חפלה'), 'project');
  assert.ok(slugifyStudioName('x'.repeat(200)).length <= 48);
});

test('a project is a folder with its name, and two projects never share one', async () => {
  await withRoot(async (root) => {
    const first = await createStudioProject('Surf ants', root, 1000);
    const second = await createStudioProject('Surf ants', root, 2000);
    assert.equal(first.id, 'surf-ants');
    assert.equal(second.id, 'surf-ants-2');
    assert.match(await readFile(path.join(root, 'surf-ants', 'AGENTS.md'), 'utf8'), /antseed-studio/);
    assert.deepEqual((await listStudioProjects(root)).map((project) => project.id), ['surf-ants-2', 'surf-ants']);
    await assert.rejects(createStudioProject('   ', root), /name/);
  });
});

test('a project reads its board and reports only files that exist', async () => {
  await withRoot(async (root) => {
    const { id } = await createStudioProject('Lighthouse', root, 1000);
    const dir = path.join(root, id);
    await mkdir(path.join(dir, 'stills'));
    await writeFile(path.join(dir, 'stills', 'shot-01.png'), 'png');
    await writeFile(path.join(dir, 'board.json'), JSON.stringify({
      shots: [
        { id: '01', status: 'still', still: 'stills/shot-01.png' },
        { id: '02', status: 'still', still: 'stills/shot-02.png' },
      ],
    }));
    const detail = await getStudioProject(id, root);
    assert.equal(detail?.project.name, 'Lighthouse');
    assert.equal(detail?.project.shotCount, 2);
    assert.equal(detail?.project.cover?.path, 'stills/shot-01.png');
    assert.deepEqual(Object.keys(detail?.files ?? {}), ['stills/shot-01.png']);
    assert.equal(detail?.boardError, null);

    await writeFile(path.join(dir, 'board.json'), '{ half a file');
    const broken = await getStudioProject(id, root);
    assert.equal(broken?.project.shotCount, 0);
    assert.match(broken?.boardError ?? '', /not valid JSON/);
    assert.equal(await getStudioProject('missing', root), null);
    assert.equal(await getStudioProject('../lighthouse', root), null);
  });
});

test('resolveStudioFile serves media inside the project only', async () => {
  await withRoot(async (root) => {
    const { id } = await createStudioProject('Lighthouse', root);
    const dir = path.join(root, id);
    const outside = path.join(root, '..', 'secret.png');
    await writeFile(outside, 'secret');
    await writeFile(path.join(dir, 'still.png'), 'png');
    await writeFile(path.join(dir, 'notes.txt'), 'text');
    await symlink(outside, path.join(dir, 'link.png'));

    assert.equal(await resolveStudioFile(id, 'still.png', root), path.join(await realpath(dir), 'still.png'));
    assert.equal(await resolveStudioFile(id, 'link.png', root), null);
    assert.equal(await resolveStudioFile(id, '../secret.png', root), null);
    assert.equal(await resolveStudioFile(id, 'notes.txt', root), null);
    assert.equal(await resolveStudioFile(id, 'project.json', root), null);
    assert.equal(await resolveStudioFile(id, 'missing.png', root), null);
    assert.equal(await resolveStudioFile('..', 'secret.png', root), null);
  });
});

test('resolveStudioFile serves nothing from a project folder that is a link out of Studio', async () => {
  await withRoot(async (root) => {
    const { id } = await createStudioProject('Lighthouse', root);
    const dir = path.join(root, id);
    const outside = await mkdtemp(path.join(tmpdir(), 'studio-outside-'));
    try {
      await writeFile(path.join(outside, 'still.png'), 'png');
      await rm(dir, { recursive: true, force: true });
      await symlink(outside, dir);
      assert.equal(await resolveStudioFile(id, 'still.png', root), null);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('a project remembers its chat, and a folder knows its project', async () => {
  await withRoot(async (root) => {
    const { id } = await createStudioProject('Lighthouse', root);
    await setStudioProjectConversation(id, 'conversation-1', root);
    assert.equal((await getStudioProject(id, root))?.project.conversationId, 'conversation-1');
    await assert.rejects(setStudioProjectConversation('missing', 'conversation-1', root), /not found/);

    assert.equal(studioProjectIdForFolder(path.join(root, id), root), id);
    assert.equal(studioProjectIdForFolder(path.join(root, id, 'stills'), root), null);
    assert.equal(studioProjectIdForFolder(root, root), null);
    assert.equal(studioProjectIdForFolder(path.join(root, '..', 'elsewhere'), root), null);
    assert.equal(studioProjectIdForFolder(undefined, root), null);
  });
});
