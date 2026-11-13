import assert from 'node:assert/strict';
import { test } from 'vitest';
import { centeredScrollTop, holdEnterInSearch } from './ChatModelDropdown';

test('Enter in the model search does not submit the composer form around it', () => {
  const pressed = (key: string) => {
    let prevented = false;
    holdEnterInSearch({ key, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(pressed('Enter'), true);
  assert.equal(pressed('a'), false);
  assert.equal(pressed('Escape'), false);
});

test('the menu opens with the selected model centered, or at the top for one near it', () => {
  // A model 1000px down a 380px menu, 60px tall: its middle at the menu's middle.
  assert.equal(centeredScrollTop(1000, 60, 380), 840);
  assert.equal(centeredScrollTop(50, 60, 380), 0);
  // Below a 40px filter row it centers in the 340px left under it.
  assert.equal(centeredScrollTop(1000, 60, 380, 40), 820);
});
