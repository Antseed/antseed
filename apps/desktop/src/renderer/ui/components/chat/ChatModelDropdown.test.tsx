import assert from 'node:assert/strict';
import { test } from 'vitest';
import { holdEnterInSearch } from './ChatModelDropdown';

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
