import { describe, expect, it } from 'vitest';
import { formatAnts, formatAntsExact, parseAnts, formatUsdc, formatBps } from './format.js';
import { assertEpochs, assertPositiveIds, assertAgentId } from './steps.js';

describe('ANTS formatting', () => {
  it('formats base units with separators and trimmed fractions', () => {
    expect(formatAnts('1000000000000000000000')).toBe('1,000');
    expect(formatAnts(1_234_567_890_000_000_000n)).toBe('1.2345');
    expect(formatAnts('99999999999999999999999')).toBe('99,999.9999');
    expect(formatAnts('0')).toBe('0');
    expect(formatAntsExact('1500000000000000000')).toBe('1.5');
    expect(formatAntsExact('1')).toBe('0.000000000000000001');
  });
  it('parses human amounts and rejects bad input', () => {
    expect(parseAnts('12.5')).toBe(12_500_000_000_000_000_000n);
    expect(parseAnts('1,000')).toBe(1_000n * 10n ** 18n);
    expect(() => parseAnts('0')).toThrow(/greater than zero/);
    expect(() => parseAnts('-1')).toThrow();
    expect(() => parseAnts('1.1234567890123456789')).toThrow(/18 decimals/);
  });
  it('formats USDC and bps', () => {
    expect(formatUsdc('1500000')).toBe('1.5');
    expect(formatBps(2916)).toBe('29.16%');
    expect(formatBps(5000)).toBe('50%');
  });
});

describe('input validation', () => {
  it('validates position ids, epochs and agent ids', () => {
    expect(assertPositiveIds(['3', 4])).toEqual([3, 4]);
    expect(() => assertPositiveIds([])).toThrow(/At least one/);
    expect(() => assertPositiveIds([1, 1])).toThrow(/repeat/);
    expect(() => assertPositiveIds([0])).toThrow(/positive/);
    expect(assertEpochs('8', 1, 104)).toBe(8);
    expect(() => assertEpochs(105, 1, 104)).toThrow(/between 1 and 104/);
    expect(() => assertEpochs(1.5, 1, 104)).toThrow();
    expect(assertAgentId('42')).toBe(42);
    expect(() => assertAgentId(0)).toThrow(/Agent ID/);
  });
});
