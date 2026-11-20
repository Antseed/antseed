import { describe, expect, it } from 'vitest';
import { nextRotationOffset, rotateHead, tiedSellerSignature } from '../src/routing/rotation.js';

describe('bounded rotation counter', () => {
  it('peeks without creating or refreshing a pool and consumes only live turns', () => {
    const rotations = new Map<string, number>();
    expect(nextRotationOffset(rotations, 'a', 3, false)).toBe(1);
    expect(rotations.size).toBe(0);
    expect(nextRotationOffset(rotations, 'a', 3, true)).toBe(1);
    nextRotationOffset(rotations, 'b', 3, true);
    expect(nextRotationOffset(rotations, 'a', 3, false)).toBe(2);
    expect([...rotations.keys()]).toEqual(['a', 'b']);
    expect(nextRotationOffset(rotations, 'a', 3, true)).toBe(2);
    expect([...rotations.keys()]).toEqual(['b', 'a']);
    expect(nextRotationOffset(rotations, 'a', 3, true)).toBe(0);
  });

  it('evicts the least recently consumed pool at the capacity limit', () => {
    const rotations = new Map<string, number>();
    for (let i = 0; i < 4096; i += 1) nextRotationOffset(rotations, String(i), 2, true);
    nextRotationOffset(rotations, '0', 2, true);
    nextRotationOffset(rotations, '1', 2, false);
    nextRotationOffset(rotations, 'new', 2, true);
    expect(rotations.size).toBe(4096);
    expect(rotations.has('0')).toBe(true);
    expect(rotations.has('1')).toBe(false);
    expect(rotations.has('new')).toBe(true);
  });

  it('wraps the unsigned counter without changing the previewed turn', () => {
    const rotations = new Map([['pool', 0xffffffff]]);
    expect(nextRotationOffset(rotations, 'pool', 3, false)).toBe(0);
    expect(nextRotationOffset(rotations, 'pool', 3, true)).toBe(0);
    expect(rotations.get('pool')).toBe(0);
    expect(nextRotationOffset(rotations, 'pool', 3, true)).toBe(0);
    expect(nextRotationOffset(rotations, 'pool', 3, true)).toBe(1);
  });
});

describe('head rotation', () => {
  it('rotates only the leading group in place', () => {
    const items = ['a', 'b', 'c', 'd'];
    expect(rotateHead(items, 3, 1)).toBe(items);
    expect(items).toEqual(['b', 'c', 'a', 'd']);
    expect(rotateHead(items, 3, 0)).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('tied seller signature', () => {
  it('sorts the leading group ids and skips empty ones', () => {
    const items = [{ id: 'C' }, { id: '' }, { id: 'a' }, { id: 'b' }];
    expect(tiedSellerSignature(items, 3, (item) => item.id)).toBe('C\na');
    expect(tiedSellerSignature(items, 3, (item) => item.id, (id) => id.toLowerCase())).toBe('a\nc');
  });
});
