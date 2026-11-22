import assert from 'node:assert/strict';
import test from 'node:test';
import { appIconAssetCandidates, shouldSetMacDockIcon } from './dock-icon.js';

test('shouldSetMacDockIcon only overrides the Dock icon in unpackaged macOS runs', () => {
  assert.equal(shouldSetMacDockIcon('darwin', false), true);
  assert.equal(shouldSetMacDockIcon('darwin', true), false);
  assert.equal(shouldSetMacDockIcon('win32', false), false);
  assert.equal(shouldSetMacDockIcon('win32', true), false);
  assert.equal(shouldSetMacDockIcon('linux', false), false);
  assert.equal(shouldSetMacDockIcon('linux', true), false);
});

test('appIconAssetCandidates prefers the macOS HIG icon only on darwin', () => {
  assert.deepEqual(appIconAssetCandidates('darwin'), [
    'antseed-mac-icon.png',
    'antseed-dock-icon.png',
    'antseed-mark.png',
  ]);
  assert.deepEqual(appIconAssetCandidates('win32'), [
    'antseed-dock-icon.png',
    'antseed-mark.png',
  ]);
  assert.deepEqual(appIconAssetCandidates('linux'), [
    'antseed-dock-icon.png',
    'antseed-mark.png',
  ]);
});
