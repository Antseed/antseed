import { describe, expect, it } from 'vitest';
import { sanitizePeerDisplayName } from '../src/discovery/display-name.js';

describe('sanitizePeerDisplayName', () => {
  it('removes decorative emoji and collapses the remaining whitespace', () => {
    expect(sanitizePeerDisplayName('Example Seller ✅  🌐')).toBe('Example Seller');
    expect(sanitizePeerDisplayName('Fast 🚀 Seller')).toBe('Fast Seller');
    expect(sanitizePeerDisplayName('▲ Apex Ant')).toBe('Apex Ant');
  });

  it('removes compound emoji sequences and flags', () => {
    expect(sanitizePeerDisplayName('Global 👩🏽‍💻 🇺🇸 Node')).toBe('Global Node');
  });

  it('preserves multilingual names and ordinary punctuation', () => {
    expect(sanitizePeerDisplayName('東京 AI — مزود')).toBe('東京 AI — مزود');
    expect(sanitizePeerDisplayName('Seller + Labs $5')).toBe('Seller + Labs $5');
  });

  it('returns undefined when no visible name remains', () => {
    expect(sanitizePeerDisplayName('✅ 🌐')).toBeUndefined();
    expect(sanitizePeerDisplayName(null)).toBeUndefined();
  });
});
