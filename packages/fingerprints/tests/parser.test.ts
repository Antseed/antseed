import { describe, expect, it } from 'vitest';
import { parseKbfAnswers } from '../src/verifiers/kbf/parser.js';

describe('parseKbfAnswers', () => {
  it('parses well-formed (N) <number> lines', () => {
    const text = '(1) 3880\n(2) 46\n(3) 299792.458';
    expect(parseKbfAnswers(text, 3)).toEqual([3880, 46, 299792.458]);
  });

  it('is position-aware: (N) index wins over line order', () => {
    const text = '(3) 30\n(1) 10';
    expect(parseKbfAnswers(text, 3)).toEqual([10, null, 30]);
  });

  it('tolerates messy whitespace and separators', () => {
    const text = '  ( 1 )   3880  \n\t(2):\t46\n 3.  1234 \n4)  55';
    expect(parseKbfAnswers(text, 4)).toEqual([3880, 46, 1234, 55]);
  });

  it('handles commas in numbers', () => {
    expect(parseKbfAnswers('(1) 384,400', 1)).toEqual([384400]);
    expect(parseKbfAnswers('(1) 1,234,567.89', 1)).toEqual([1234567.89]);
  });

  it('handles scientific notation', () => {
    expect(parseKbfAnswers('(1) 3.88e3\n(2) 1.6E-19', 2)).toEqual([3880, 1.6e-19]);
  });

  it('handles trailing units and prose around the number', () => {
    const text = '(1) 3880°C\n(2) approximately 46 chromosomes\n(3) 687 days';
    expect(parseKbfAnswers(text, 3)).toEqual([3880, 46, 687]);
  });

  it('preserves negative answers, including with no space after the index', () => {
    expect(parseKbfAnswers('(1) -430\n(2)-273.15', 2)).toEqual([-430, -273.15]);
  });

  it('returns null for missing positions', () => {
    expect(parseKbfAnswers('(1) 5\n(3) 7', 4)).toEqual([5, null, 7, null]);
  });

  it('returns null for unparseable lines', () => {
    expect(parseKbfAnswers('(1) unknown\n(2) 42', 2)).toEqual([null, 42]);
  });

  it('ignores extra prose lines and out-of-range indices', () => {
    const text = [
      'Sure! Here are the answers:',
      '(1) 100',
      'Note that 1990 was a different value.',
      '(9) 900',
      '(2) 200',
      'Hope this helps!',
    ].join('\n');
    expect(parseKbfAnswers(text, 2)).toEqual([100, 200]);
  });

  it('keeps the first value when an index repeats', () => {
    expect(parseKbfAnswers('(1) 10\n(1) 20', 1)).toEqual([10]);
  });

  it('handles empty input and zero probe count', () => {
    expect(parseKbfAnswers('', 3)).toEqual([null, null, null]);
    expect(parseKbfAnswers('(1) 5', 0)).toEqual([]);
  });
});
