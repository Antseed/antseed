import { describe, expect, it } from 'vitest';
import { nextRotationOffset } from '../src/routing/rotation.js';

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
