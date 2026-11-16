// The Antseed skills find the gateway in $ANTSEED_PROXY_URL. When it isn't
// set they must stop and have the agent ask the user, never fall back to the
// keyless local buyer on 8377, which skips the gateway and is paid by
// whichever buyer runs there. These tests run each skill's own gateway line,
// as the agent would, in a clean environment.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** Files with the gateway line the agent runs. */
const COMMAND_FILES = [
  'skills/antseed-ask/SKILL.md',
  'skills/antseed-images/SKILL.md',
  'skills/antseed-videos/references/requests.md',
];
/** Every file that tells the agent where the gateway is. */
const TEXT_FILES = [...COMMAND_FILES, 'skills/antseed-videos/SKILL.md'];

function read(file: string): string {
  return readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
}

const shells = ['bash', 'zsh'].filter((shell) => spawnSync('sh', ['-c', `command -v ${shell}`]).status === 0);

function gatewayLine(file: string): string {
  const lines = read(file).split('\n').filter((line) => line.startsWith('proxy_url='));
  if (lines.length !== 1) throw new Error(`${file}: expected one proxy_url= line, found ${lines.length}`);
  return lines[0]!;
}

function run(shell: string, line: string, env: Record<string, string>) {
  return spawnSync(shell, ['-c', `${line}\nprintf '%s' "$proxy_url"`], {
    env: { PATH: process.env['PATH'] ?? '', HOME: '/nonexistent', ...env },
    encoding: 'utf8',
  });
}

describe.each(TEXT_FILES)('%s', (file) => {
  it('never names the local buyer as a default', () => {
    const text = read(file);
    expect(text).not.toContain(':-http://127.0.0.1:8377');
    expect(text).not.toMatch(/(?:otherwise|then|normally at) `?http:\/\/127\.0\.0\.1:8377/);
  });
});

describe.each(COMMAND_FILES)('%s', (file) => {
  describe.each(shells)('in %s', (shell) => {
    it('stops and says to ask the user when no gateway is set', () => {
      const result = run(shell, gatewayLine(file), {});
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('No Antseed gateway found');
      expect(result.stderr).toContain('Ask the user');
    });

    it('uses $ANTSEED_PROXY_URL when it is set', () => {
      const result = run(shell, gatewayLine(file), { ANTSEED_PROXY_URL: 'https://gateway.example' });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('https://gateway.example');
    });
  });
});
