import { describe, expect, it } from 'vitest';
import { makeError } from 'ethers';
import { describeError } from './jobs.js';
import { poolErrorName, poolRevertMessage } from './pool-errors.js';

/** What ethers throws for `mergeStakes` with an ABI that lists no pool errors (issue #1390). */
const unknownCustomError = (data: string) => makeError('execution reverted (unknown custom error)', 'CALL_EXCEPTION', {
  action: 'call', data, reason: null, transaction: { to: null, data: '0x' }, invocation: null, revert: null,
});

describe('pool custom errors', () => {
  it('names InvalidValue (0xaa7feadc) instead of "unknown custom error"', () => {
    const error = unknownCustomError('0xaa7feadc');
    expect(describeError(new Error('execution reverted (unknown custom error)'))).toContain('unknown custom error');
    expect(poolErrorName(error)).toBe('InvalidValue');
    expect(describeError(error)).not.toContain('unknown custom error');
    expect(describeError(error)).toContain('rejected one of the values');
  });

  it('explains a refused merge in merge terms', () => {
    expect(poolRevertMessage(unknownCustomError('0xaa7feadc'), 'merge')).toContain('started their locks at different epochs');
  });

  it('finds the selector in nested RPC errors and in wallet messages', () => {
    expect(poolErrorName({ info: { error: { code: 3, data: '0x767c77e5' } } })).toBe('PositionChangePending');
    expect(poolErrorName(new Error('The contract reverted with the following signature: 0xaa7feadc'))).toBe('InvalidValue');
  });

  it('ignores reverts that are not pool errors', () => {
    expect(poolErrorName(unknownCustomError('0x12345678'))).toBeNull();
    expect(poolRevertMessage(new Error('RPC unavailable'))).toBeNull();
  });
});
