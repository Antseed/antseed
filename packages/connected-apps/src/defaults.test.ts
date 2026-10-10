import test from 'node:test';
import assert from 'node:assert/strict';

import path from 'node:path';
import { homedir } from 'node:os';

import { DEFAULT_APP_PROFILES, mergeWithDefaultAppProfiles, platformConfigPath } from './defaults.js';

function names(profiles: readonly unknown[]): string[] {
  return profiles.map((profile) => (profile as Record<string, unknown>)['name'] as string);
}

const DEFAULT_NAMES = ['opencode', 'codex', 'claude-code', 'claude-desktop', 'hermes', 'droid', 't3code', 'pi', 'gooeypi', 'prime-agent', 'crush', 'goose', 'zed'];

test('default app profiles are config-patch entries with unique names', () => {
  assert.deepEqual(names(DEFAULT_APP_PROFILES), DEFAULT_NAMES);
  for (const profile of DEFAULT_APP_PROFILES) {
    assert.equal(profile['kind'], 'config-patch');
    const patch = profile['configPatch'] as Record<string, unknown>;
    assert.equal(typeof patch['configPath'], 'string');
    // The claude-desktop format writes no provider entry (its gateway
    // ignores auth), so it alone carries no providerKey; it also talks to
    // the desktop's Claude gateway while every other tool is pointed
    // straight at the buyer proxy.
    if (patch['format'] !== 'claude-desktop') {
      assert.equal(typeof patch['providerKey'], 'string');
    }
    const portPlaceholder = patch['format'] === 'claude-desktop' ? '{claudeGatewayPort}' : '{buyerPort}';
    assert.ok((patch['baseURL'] as string).includes(portPlaceholder));
    const slugs = profile['toolSlugs'] as string[];
    assert.ok(Array.isArray(slugs) && slugs.length > 0);
  }
});

test('Claude Desktop patches the third-party profile and opens Claude on connect', () => {
  const profile = DEFAULT_APP_PROFILES.find((entry) => entry['name'] === 'claude-desktop');
  assert.ok(profile);
  // 'open-tool' launches Claude after connect even when it was not running;
  // restartAppName doubles as the restart target and the launch fallback.
  assert.equal(profile['appAction'], 'open-tool');
  assert.equal(profile['restartAppName'], 'Claude');
  const patch = profile['configPatch'] as Record<string, unknown>;
  assert.equal(patch['format'], 'claude-desktop');
  assert.equal(typeof patch['thirdPartyDir'], 'string');
});

test('Claude Code and T3 Code use distinct conversation sources', () => {
  const claudeCode = DEFAULT_APP_PROFILES.find((entry) => entry['name'] === 'claude-code');
  const t3code = DEFAULT_APP_PROFILES.find((entry) => entry['name'] === 't3code');
  assert.deepEqual(claudeCode?.['toolSlugs'], ['claude-code']);
  assert.deepEqual(claudeCode?.['configPatch'], {
    format: 'claude-code',
    configPath: '~/.claude/settings.json',
    providerKey: 'antseed',
    baseURL: 'http://localhost:{buyerPort}',
    installProbe: 'claude',
  });
  assert.deepEqual(t3code?.['toolSlugs'], ['t3code']);
});

test('GooeyPi patches the shared Pi config without requiring pi on PATH', () => {
  const profile = DEFAULT_APP_PROFILES.find((entry) => entry['name'] === 'gooeypi');
  assert.ok(profile);
  assert.deepEqual(profile['toolSlugs'], ['gooeypi']);
  assert.deepEqual(profile['configPatch'], {
    format: 'pi',
    configPath: '~/.pi/agent/models.json',
    settingsPath: '~/.pi/agent/settings.json',
    providerKey: 'antseed-gooeypi',
    baseURL: 'http://localhost:{buyerPort}/v1',
    api: 'openai-responses',
    originator: 'gooeypi',
  });
});

test('Prime Agent patches its own pi-format config under ~/.prime/agent', () => {
  const profile = DEFAULT_APP_PROFILES.find((entry) => entry['name'] === 'prime-agent');
  assert.ok(profile);
  assert.equal(profile['displayName'], 'Prime Agent');
  assert.deepEqual(profile['toolSlugs'], ['prime-agent']);
  assert.deepEqual(profile['configPatch'], {
    format: 'pi',
    configPath: '~/.prime/agent/models.json',
    settingsPath: '~/.prime/agent/settings.json',
    providerKey: 'antseed',
    baseURL: 'http://localhost:{buyerPort}/v1',
    api: 'openai-responses',
    originator: 'prime-agent',
    installProbe: 'prime-agent',
  });
});

test('Hermes opens the installed Hermes desktop application by default', () => {
  const profile = DEFAULT_APP_PROFILES.find((entry) => entry['name'] === 'hermes');
  assert.ok(profile);
  assert.equal(profile['appAction'], 'open-tool');
  assert.equal(profile['toolName'], 'hermes');
  assert.equal(profile['restartAppName'], 'Hermes');
  assert.equal(profile['openUrl'], undefined);
});

test('platformConfigPath keeps the posix path off Windows and for home-rooted tools', () => {
  const winFolder = { base: 'APPDATA', segments: ['Zed', 'settings.json'] } as const;
  assert.equal(platformConfigPath('~/.config/zed/settings.json', winFolder, 'darwin'), '~/.config/zed/settings.json');
  assert.equal(platformConfigPath('~/.config/zed/settings.json', winFolder, 'linux'), '~/.config/zed/settings.json');
  // Home-rooted tools pass no Windows folder — same path everywhere.
  assert.equal(platformConfigPath('~/.codex/config.toml', null, 'win32'), '~/.codex/config.toml');
});

test('platformConfigPath resolves Windows known folders from the environment', () => {
  const env = { APPDATA: 'C:\\Users\\jo\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\jo\\AppData\\Local' };
  assert.equal(
    platformConfigPath('~/.config/zed/settings.json', { base: 'APPDATA', segments: ['Zed', 'settings.json'] }, 'win32', env),
    path.join('C:\\Users\\jo\\AppData\\Roaming', 'Zed', 'settings.json'),
  );
  assert.equal(
    platformConfigPath('~/.config/crush/crush.json', { base: 'LOCALAPPDATA', segments: ['crush', 'crush.json'] }, 'win32', env),
    path.join('C:\\Users\\jo\\AppData\\Local', 'crush', 'crush.json'),
  );
});

test('platformConfigPath falls back to the conventional folder when the env var is unset', () => {
  assert.equal(
    platformConfigPath('~/.config/goose/config.yaml', { base: 'APPDATA', segments: ['Block', 'goose', 'config', 'config.yaml'] }, 'win32', {}),
    path.join(homedir(), 'AppData', 'Roaming', 'Block', 'goose', 'config', 'config.yaml'),
  );
});

test('mergeWithDefaultAppProfiles returns the defaults when no external profiles are configured', () => {
  assert.deepEqual(names(mergeWithDefaultAppProfiles([])), DEFAULT_NAMES);
});

test('mergeWithDefaultAppProfiles lets external profiles override same-name defaults and keep their order', () => {
  const external = [
    { name: 'acme', displayName: 'Acme Desktop' },
    { name: 'opencode', displayName: 'OpenCode (private override)' },
  ];
  const merged = mergeWithDefaultAppProfiles(external);
  assert.deepEqual(names(merged), ['acme', 'opencode', 'codex', 'claude-code', 'claude-desktop', 'hermes', 'droid', 't3code', 'pi', 'gooeypi', 'prime-agent', 'crush', 'goose', 'zed']);
  assert.equal((merged[1] as Record<string, unknown>)['displayName'], 'OpenCode (private override)');
});
