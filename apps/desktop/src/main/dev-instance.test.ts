import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRemoveSharedConfigPatches } from './dev-instance.js';

const MULTI_INSTANCE_ENV = 'ANTSEED_DESKTOP_MULTI_INSTANCE';

test('explicit disconnect removes shared config patches in multi-instance development', () => {
  const previous = process.env[MULTI_INSTANCE_ENV];
  process.env[MULTI_INSTANCE_ENV] = '1';
  try {
    assert.equal(shouldRemoveSharedConfigPatches('disconnect'), true);
    assert.equal(shouldRemoveSharedConfigPatches('shutdown'), false);
  } finally {
    if (previous === undefined) delete process.env[MULTI_INSTANCE_ENV];
    else process.env[MULTI_INSTANCE_ENV] = previous;
  }
});

test('single-instance shutdown removes shared config patches', () => {
  const previous = process.env[MULTI_INSTANCE_ENV];
  delete process.env[MULTI_INSTANCE_ENV];
  try {
    assert.equal(shouldRemoveSharedConfigPatches('disconnect'), true);
    assert.equal(shouldRemoveSharedConfigPatches('shutdown'), true);
  } finally {
    if (previous === undefined) delete process.env[MULTI_INSTANCE_ENV];
    else process.env[MULTI_INSTANCE_ENV] = previous;
  }
});

test('a testbench desktop never removes shared config patches, on stop or quit', () => {
  const keys = ['ANTSEED_DESKTOP_ATTACH_ONLY', 'ANTSEED_DESKTOP_ISOLATED_PROFILE', MULTI_INSTANCE_ENV];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const flag of ['ANTSEED_DESKTOP_ATTACH_ONLY', 'ANTSEED_DESKTOP_ISOLATED_PROFILE']) {
      for (const key of keys) delete process.env[key];
      process.env[flag] = '1';
      assert.equal(shouldRemoveSharedConfigPatches('disconnect'), false, `${flag}: explicit stop`);
      assert.equal(shouldRemoveSharedConfigPatches('shutdown'), false, `${flag}: quit`);
    }
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
