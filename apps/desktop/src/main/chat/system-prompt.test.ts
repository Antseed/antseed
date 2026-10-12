import test from 'node:test';
import assert from 'node:assert/strict';

import { VPR_SYSTEM_PROMPT, buildVprSystemPrompt } from './system-prompt.js';

test('prompt has AI VPN identity, not pi', () => {
  const prompt = buildVprSystemPrompt(undefined);
  assert.ok(prompt.includes('AI VPN'));
  assert.ok(!prompt.includes('operating inside pi'));
});

test('prompt lists all built-in and custom tools', () => {
  const prompt = buildVprSystemPrompt(undefined);
  for (const tool of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls',
    'web_fetch', 'open_browser_preview', 'start_dev_server']) {
    assert.ok(prompt.includes(`- ${tool}:`), `missing tool "${tool}"`);
  }
});

test('prompt uses pi section names', () => {
  const prompt = buildVprSystemPrompt(undefined);
  assert.ok(prompt.includes('Available tools:'));
  assert.ok(prompt.includes('Guidelines:'));
});

test('guidelines include key tool rules', () => {
  const prompt = buildVprSystemPrompt(undefined);
  assert.ok(/never.*bash.*dev server/i.test(prompt));
  assert.ok(prompt.includes('web_fetch'));
  assert.ok(prompt.includes('edits[].oldText must match exactly'));
});

test('no pi documentation section', () => {
  const prompt = buildVprSystemPrompt(undefined);
  assert.ok(!prompt.includes('Pi documentation'));
});

test('custom base prompt overrides default', () => {
  const custom = 'You are a helpful assistant.';
  const prompt = buildVprSystemPrompt(custom);
  assert.ok(prompt.includes(custom));
  assert.ok(!prompt.includes(VPR_SYSTEM_PROMPT));
});

test('workspace dir is included when provided', () => {
  const ws = '/Users/test/Development/myrepo';
  const prompt = buildVprSystemPrompt(undefined, ws);
  assert.ok(prompt.includes(`Current workspace: ${ws}`));
});

test('workspace dir is omitted when not provided', () => {
  const prompt = buildVprSystemPrompt(undefined);
  assert.ok(!prompt.includes('Current workspace:'));
});

test('workspace dir is omitted when blank', () => {
  const prompt = buildVprSystemPrompt(undefined, '   ');
  assert.ok(!prompt.includes('Current workspace:'));
});

test('workspace dir is trimmed before injection', () => {
  const ws = '/Users/test/Development/myrepo';
  const prompt = buildVprSystemPrompt(undefined, `  ${ws}  `);
  assert.ok(prompt.includes(`Current workspace: ${ws}`));
});

test('full access mode tells agent not to ask for command permission', () => {
  const prompt = buildVprSystemPrompt(undefined, '/tmp/workspace', 'full');
  assert.ok(prompt.includes('Full access mode is enabled'));
  assert.ok(/do not ask.*permission.*commands/i.test(prompt));
});
