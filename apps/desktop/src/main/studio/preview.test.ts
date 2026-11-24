import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initStudioPreview, setStudioPreviewEnabled, studioPreviewEnabled } from './preview.js';

test('Studio is off until it is turned on, and the choice is kept', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-studio-preview-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'userData', 'studio-preview.json');
  initStudioPreview(file);
  assert.equal(studioPreviewEnabled(), false, 'off with no file');
  assert.equal(setStudioPreviewEnabled(true), true);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { enabled: true });
  initStudioPreview(file);
  assert.equal(studioPreviewEnabled(), true, 'read back after a restart');
  setStudioPreviewEnabled(false);
  initStudioPreview(file);
  assert.equal(studioPreviewEnabled(), false);
  await writeFile(file, 'not json');
  initStudioPreview(file);
  assert.equal(studioPreviewEnabled(), false, 'a damaged file means off');
});
