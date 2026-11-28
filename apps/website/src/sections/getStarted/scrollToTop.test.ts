import assert from 'node:assert/strict';
import {test} from 'node:test';
import {scrollToTop} from './scrollToTop.ts';

// Current Chrome returns a Promise from window.scrollTo. React keeps whatever an effect returns as its cleanup and calls it on the
// next screen change, so an effect that returned scrollTo's value crashed the page.
test('scrolls to the top and returns nothing React would call as a cleanup', () => {
  const calls: number[][] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {scrollTo: (x: number, y: number) => { calls.push([x, y]); return Promise.resolve(); }},
  });
  try {
    assert.equal(scrollToTop(), undefined);
    assert.deepEqual(calls, [[0, 0]]);
  } finally {
    // put the global back as it was (Node has no window), so no other test in the process sees the mock
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
