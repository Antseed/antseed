import assert from 'node:assert/strict';
import test from 'node:test';

import { toolDesktopAppNames } from './tool-resume.js';

test('GooeyPi profiles auto-detect the GooeyPi desktop application', () => {
  assert.equal(toolDesktopAppNames('gooeypi')[0], 'GooeyPi');
});

test('Hermes profiles auto-detect the Hermes desktop application', () => {
  assert.equal(toolDesktopAppNames('hermes')[0], 'Hermes');
});

test('Cursor conversations open the Cursor desktop application', () => {
  assert.equal(toolDesktopAppNames('cursor')[0], 'Cursor');
});
