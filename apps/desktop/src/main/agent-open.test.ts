import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCommand, openAgent } from './agent-open.js';

test('each agent that takes the skills has a fixed command', () => {
  assert.equal(agentCommand('claude-code'), 'claude');
  assert.equal(agentCommand('codex'), 'codex');
  assert.equal(agentCommand('opencode'), 'opencode');
  assert.equal(agentCommand('hermes'), 'hermes');
  assert.equal(agentCommand('pi'), 'pi');
  assert.equal(agentCommand('droid'), 'droid');
});

test('ids outside the list never reach a shell', async () => {
  for (const id of ['', 'cursor', 'toString', '__proto__', 'codex; rm -rf ~', '"claude"']) {
    assert.equal(agentCommand(id), null);
    assert.deepEqual(await openAgent(id), { ok: false, error: 'Unknown agent.' });
  }
});

function fakes(target: { name: string; path: string } | null, appOk = true) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      platform: 'darwin' as NodeJS.Platform,
      launchTarget: async (id: string) => { calls.push(`target:${id}`); return target; },
      launchApp: async (t: { name: string }) => { calls.push(`app:${t.name}`); return appOk ? { ok: true } : { ok: false, error: 'gone' }; },
      runInTerminal: async (command: string) => { calls.push(`terminal:${command}`); },
    },
  };
}

test('an agent with a desktop app opens the app', async () => {
  const { calls, deps } = fakes({ name: 'ChatGPT', path: '/Applications/ChatGPT.app' });
  assert.deepEqual(await openAgent('codex', deps), { ok: true, via: 'app' });
  assert.deepEqual(calls, ['target:codex', 'app:ChatGPT']);
});

test('a CLI agent opens in Terminal on macOS', async () => {
  const { calls, deps } = fakes(null);
  assert.deepEqual(await openAgent('claude-code', deps), { ok: true, via: 'terminal' });
  assert.deepEqual(calls, ['target:claude-code', 'terminal:claude']);
});

test('a desktop app that fails to launch falls back to Terminal', async () => {
  const { calls, deps } = fakes({ name: 'ChatGPT', path: '/Applications/ChatGPT.app' }, false);
  assert.deepEqual(await openAgent('codex', deps), { ok: true, via: 'terminal' });
  assert.deepEqual(calls, ['target:codex', 'app:ChatGPT', 'terminal:codex']);
});

test('elsewhere a CLI agent names the command to run', async () => {
  const { calls, deps } = fakes(null);
  assert.deepEqual(await openAgent('pi', { ...deps, platform: 'linux' }), { ok: false, error: 'Run `pi` in a terminal to start it.' });
  assert.deepEqual(calls, ['target:pi']);
});
