import { describe, expect, it } from 'vitest';
import { linkedPoolId } from './pool-link';

describe('linked seller pool', () => {
  it('reads a positive agent id and ignores malformed ones', () => {
    expect(linkedPoolId(new URLSearchParams('pool=956159'))).toBe(956159);
    for (const query of ['', 'pool=', 'pool=0', 'pool=-3', 'pool=12abc', 'pool=1.5']) {
      expect(linkedPoolId(new URLSearchParams(query))).toBeNull();
    }
  });
});
