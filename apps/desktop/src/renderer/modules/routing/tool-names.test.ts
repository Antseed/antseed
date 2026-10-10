import { describe, expect, it } from 'vitest';
import { displayToolName } from './tool-names';

describe('displayToolName', () => {
  it('maps known tool slugs to product names', () => {
    expect(displayToolName('claude-code')).toBe('Claude Code');
    expect(displayToolName('droid')).toBe('Droid');
    expect(displayToolName('opencode')).toBe('OpenCode');
    expect(displayToolName('pi')).toBe('pi');
    expect(displayToolName('prime-agent')).toBe('Prime Agent');
  });

  it('collapses every codex originator variant to Codex', () => {
    expect(displayToolName('codex')).toBe('Codex');
    expect(displayToolName('codex-cli-rs')).toBe('Codex');
    expect(displayToolName('codex-tui')).toBe('Codex');
  });

  it('falls back to a generic label for unknown identities', () => {
    expect(displayToolName('unknown')).toBe('App');
    expect(displayToolName('')).toBe('App');
  });

  it('prettifies unrecognized slugs', () => {
    expect(displayToolName('some-new-tool')).toBe('Some New Tool');
  });
});
