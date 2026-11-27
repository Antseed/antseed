import assert from 'node:assert/strict';
import {test} from 'node:test';
import {scrollToTop} from './scrollToTop.ts';

// Current Chrome returns a Promise from window.scrollTo. React keeps whatever an effect returns as its cleanup and calls it on the
// next screen change, so an effect that returned scrollTo's value crashed the page.
test('scrolls to the top and returns nothing React would call as a cleanup', () => {
  const calls: number[][] = [];
  Object.assign(globalThis, {window: {scrollTo: (x: number, y: number) => { calls.push([x, y]); return Promise.resolve(); }}});
  assert.equal(scrollToTop(), undefined);
  assert.deepEqual(calls, [[0, 0]]);
});
