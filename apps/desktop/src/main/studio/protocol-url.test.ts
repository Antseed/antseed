import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStudioUrl } from './protocol-url.js';

test('parseStudioUrl reads the project and the path inside it', () => {
  assert.deepEqual(parseStudioUrl('antseed-studio://project/lighthouse/stills/shot-01.png?v=12'), {
    projectId: 'lighthouse',
    filePath: 'stills/shot-01.png',
  });
  assert.deepEqual(parseStudioUrl('antseed-studio://project/2024/final%20cut.mp4'), {
    projectId: '2024',
    filePath: 'final cut.mp4',
  });
});

test('parseStudioUrl refuses anything that could leave the project', () => {
  for (const url of [
    'antseed-attachment://project/lighthouse/stills/a.png',
    'antseed-studio://other/lighthouse/stills/a.png',
    'antseed-studio://project/lighthouse',
    'antseed-studio://project/lighthouse/',
    'antseed-studio://project/Light_House/a.png',
    'antseed-studio://project/lighthouse/%2e%2e/secret.png',
    'antseed-studio://project/lighthouse/stills%2f..%2f..%2fsecret.png',
    'antseed-studio://project/lighthouse/stills%5csecret.png',
    'antseed-studio://project/lighthouse/%zz.png',
    'not a url',
  ]) {
    assert.equal(parseStudioUrl(url), null, url);
  }
});
