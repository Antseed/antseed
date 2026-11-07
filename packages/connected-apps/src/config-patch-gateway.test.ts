import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

import {
  configPatchBaseUrl,
  isConfigPatchConnected,
  removeConfigPatch,
  writeConfigPatch,
  type ConfigPatchDef,
  type ConfigPatchTarget,
} from './config-patch.js';

const KEY = 'antseed_test_0123456789';
const MODELS = [
  { id: 'deepseek-v3.2', label: 'DeepSeek V3.2' },
  { id: 'qwen3-coder' },
  { id: 'kimi-k2', label: 'Kimi K2' },
] as const;
const LOCAL: ConfigPatchTarget = { origin: 'http://localhost:8379', apiKey: KEY, models: MODELS };
const REMOTE: ConfigPatchTarget = { origin: 'https://gw.example.com/', apiKey: KEY, models: MODELS, defaultModel: 'kimi-k2' };

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-gateway-patch-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const readJson = async (file: string): Promise<Record<string, any>> => JSON.parse(await readFile(file, 'utf8'));

test('configPatchBaseUrl swaps the origin in and only rewrites loopback hosts for WSL', () => {
  assert.equal(configPatchBaseUrl('http://localhost:{buyerPort}/v1', LOCAL), 'http://localhost:8379/v1');
  assert.equal(configPatchBaseUrl('http://localhost:{buyerPort}', REMOTE), 'https://gw.example.com');
  assert.equal(configPatchBaseUrl('http://localhost:{buyerPort}/v1', REMOTE), 'https://gw.example.com/v1');
  assert.equal(configPatchBaseUrl('http://localhost:{buyerPort}/v1', LOCAL, '172.29.32.1'), 'http://172.29.32.1:8379/v1');
  assert.equal(configPatchBaseUrl('http://localhost:{buyerPort}/v1', REMOTE, '172.29.32.1'), 'https://gw.example.com/v1');
  // Legacy port form is unchanged.
  assert.equal(configPatchBaseUrl('http://127.0.0.1:{buyerPort}/v1', 9456), 'http://127.0.0.1:9456/v1');
  assert.equal(configPatchBaseUrl('http://localhost:{buyerPort}/v1', 9456, '172.29.32.1'), 'http://172.29.32.1:9456/v1');
});

test('opencode: gateway target writes key, every model, preserves a user pick and replaces a stale one', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'opencode.json');
    const patch: ConfigPatchDef = {
      configPath, providerKey: 'antseed', npm: '@ai-sdk/openai-compatible', providerName: 'Antseed',
      baseURL: 'http://localhost:{buyerPort}/v1',
    };
    // Legacy install being migrated: the alias model is stale.
    writeConfigPatch(patch, 8377);
    assert.equal((await readJson(configPath))['model'], 'antseed/antseed');

    writeConfigPatch(patch, LOCAL);
    let config = await readJson(configPath);
    assert.equal(config['provider']['antseed']['options']['baseURL'], 'http://localhost:8379/v1');
    assert.equal(config['provider']['antseed']['options']['apiKey'], KEY);
    assert.deepEqual(Object.keys(config['provider']['antseed']['models']), MODELS.map((m) => m.id));
    assert.equal(config['provider']['antseed']['models']['qwen3-coder']['name'], 'qwen3-coder');
    assert.equal(config['provider']['antseed']['models']['kimi-k2']['name'], 'Kimi K2');
    assert.equal(config['model'], 'antseed/deepseek-v3.2');

    // User picks a model inside opencode; re-patch keeps it.
    config['model'] = 'antseed/kimi-k2';
    await writeFile(configPath, JSON.stringify(config), 'utf8');
    writeConfigPatch(patch, REMOTE);
    config = await readJson(configPath);
    assert.equal(config['model'], 'antseed/kimi-k2');
    assert.equal(config['provider']['antseed']['options']['baseURL'], 'https://gw.example.com/v1');

    // The gateway stops serving it: replaced by the default.
    writeConfigPatch(patch, { ...LOCAL, models: MODELS.slice(0, 2), defaultModel: 'qwen3-coder' });
    assert.equal((await readJson(configPath))['model'], 'antseed/qwen3-coder');

    assert.equal(removeConfigPatch(patch), true);
    config = await readJson(configPath);
    assert.equal(config['provider']['antseed'], undefined);
    assert.equal(config['model'], undefined);
  });
});

test('empty model list writes base URL + key but no selection', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'opencode.json');
    await writeFile(configPath, JSON.stringify({ model: 'openai/gpt-5' }), 'utf8');
    const patch: ConfigPatchDef = {
      configPath, providerKey: 'antseed', npm: '@ai-sdk/openai-compatible', providerName: 'Antseed',
      baseURL: 'http://localhost:{buyerPort}/v1',
    };
    writeConfigPatch(patch, { ...LOCAL, models: [] });
    const config = await readJson(configPath);
    assert.equal(config['model'], 'openai/gpt-5');
    assert.deepEqual(config['provider']['antseed']['models'], {});
    assert.equal(config['provider']['antseed']['options']['apiKey'], KEY);
  });
});

test('codex: bearer token in the provider table and selection rules', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.toml');
    const patch: ConfigPatchDef = {
      format: 'codex', configPath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1',
    };
    writeConfigPatch(patch, REMOTE);
    let raw = await readFile(configPath, 'utf8');
    assert.ok(raw.includes('base_url = "https://gw.example.com/v1"'));
    assert.ok(raw.includes(`experimental_bearer_token = "${KEY}"`));
    assert.ok(raw.includes('model = "kimi-k2"'));

    await writeFile(configPath, raw.replace('model = "kimi-k2"', 'model = "qwen3-coder"'), 'utf8');
    writeConfigPatch(patch, REMOTE);
    raw = await readFile(configPath, 'utf8');
    assert.ok(raw.includes('model = "qwen3-coder"'));

    // Legacy write never carries a credential.
    writeConfigPatch(patch, 8377);
    assert.ok(!(await readFile(configPath, 'utf8')).includes('experimental_bearer_token'));

    assert.equal(removeConfigPatch(patch), true);
    assert.equal(await readFile(configPath, 'utf8'), '');
  });
});

test('pi and crush: key, full model list, per-slot selection', async () => {
  await withDir(async (dir) => {
    const modelsPath = path.join(dir, 'models.json');
    const settingsPath = path.join(dir, 'settings.json');
    const pi: ConfigPatchDef = {
      format: 'pi', configPath: modelsPath, settingsPath, providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}/v1', api: 'openai-completions',
    };
    await writeFile(settingsPath, JSON.stringify({ defaultProvider: 'antseed', defaultModel: 'qwen3-coder' }), 'utf8');
    writeConfigPatch(pi, LOCAL);
    const models = await readJson(modelsPath);
    assert.equal(models['providers']['antseed']['apiKey'], KEY);
    assert.deepEqual(models['providers']['antseed']['models'].map((m: { id: string }) => m.id), MODELS.map((m) => m.id));
    assert.equal((await readJson(settingsPath))['defaultModel'], 'qwen3-coder');

    const crushPath = path.join(dir, 'crush.json');
    const crush: ConfigPatchDef = {
      format: 'crush', configPath: crushPath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1',
    };
    await writeFile(crushPath, JSON.stringify({ models: { large: { provider: 'antseed', model: 'kimi-k2' }, small: { provider: 'antseed', model: 'antseed' } } }), 'utf8');
    writeConfigPatch(crush, LOCAL);
    const config = await readJson(crushPath);
    assert.equal(config['providers']['antseed']['api_key'], KEY);
    assert.equal(config['providers']['antseed']['models'].length, 3);
    assert.deepEqual(config['models'], {
      large: { provider: 'antseed', model: 'kimi-k2' },
      small: { provider: 'antseed', model: 'deepseek-v3.2' },
    });
  });
});

test('goose: gateway patch is a custom provider with the key and every model', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const providerPath = path.join(dir, 'custom_providers', 'custom_antseed.json');
    await writeFile(configPath, 'keep_me: true\n', 'utf8');
    const patch: ConfigPatchDef = { format: 'goose', configPath, providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' };
    writeConfigPatch(patch, REMOTE);
    let config = parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(config['GOOSE_PROVIDER'], 'custom_antseed');
    assert.equal(config['GOOSE_MODEL'], 'kimi-k2');
    assert.equal(config['OPENAI_API_KEY'], undefined);
    const provider = JSON.parse(await readFile(providerPath, 'utf8'));
    assert.equal(provider.base_url, 'https://gw.example.com/v1/chat/completions');
    assert.equal(provider.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(provider.models.length, REMOTE.models.length);
    assert.equal(isConfigPatchConnected(patch), true);

    // User switches model in goose.
    await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('"kimi-k2"', '"qwen3-coder"'), 'utf8');
    writeConfigPatch(patch, REMOTE);
    config = parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(config['GOOSE_MODEL'], 'qwen3-coder');

    assert.equal(removeConfigPatch(patch), true);
    assert.deepEqual(parse(await readFile(configPath, 'utf8')), { keep_me: true });
    assert.equal(existsSync(providerPath), false);
    assert.equal(isConfigPatchConnected(patch), false);
  });
});

test('goose: the earlier gateway patch moves to the custom provider, keeping the pick', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    await writeFile(configPath, 'GOOSE_PROVIDER: "openai"\nGOOSE_MODEL: "qwen3-coder"\nOPENAI_HOST: "https://gw.example.com"\nOPENAI_API_KEY: "old"\n', 'utf8');
    await writeFile(`${configPath}.antseed.state.json`, JSON.stringify({ version: 1, host: 'https://gw.example.com', apiKeySha256: 'x' }), 'utf8');
    const patch: ConfigPatchDef = { format: 'goose', configPath, providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' };
    writeConfigPatch(patch, REMOTE);
    const config = parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(config['GOOSE_PROVIDER'], 'custom_antseed');
    assert.equal(config['GOOSE_MODEL'], 'qwen3-coder');
    assert.equal(config['OPENAI_HOST'], undefined);
    assert.equal(existsSync(`${configPath}.antseed.state.json`), false);
  });
});

test('codex: every model goes in a catalog, dropped again if Codex rejects it', { skip: process.platform === 'win32' }, async () => {
  await withDir(async (dir) => {
    const bin = path.join(dir, 'bin');
    await mkdir(bin);
    const fakeCodex = (exitCode: number) => writeFile(path.join(bin, 'codex'), `#!/bin/sh
if [ "$3" = "--bundled" ]; then echo '{"models":[{"base_instructions":"be good","truncation_policy":{"mode":"tokens","limit":1}}]}'; exit 0; fi
exit ${exitCode}
`, { mode: 0o755 });
    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${bin}${path.delimiter}${originalPath}`;
    try {
      const home = path.join(dir, 'home');
      await mkdir(home);
      const configPath = path.join(home, 'config.toml');
      const catalogPath = path.join(home, 'antseed-models.json');
      const patch: ConfigPatchDef = { format: 'codex', configPath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' };

      await fakeCodex(0);
      writeConfigPatch(patch, REMOTE);
      assert.ok((await readFile(configPath, 'utf8')).includes('model_catalog_json = "antseed-models.json"'));
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
      assert.deepEqual(catalog.models.map((m: { slug: string }) => m.slug), REMOTE.models.map((m) => m.id));
      assert.equal(catalog.models[0].base_instructions, 'be good');

      assert.equal(removeConfigPatch(patch), true);
      assert.equal(existsSync(catalogPath), false);
      assert.equal(await readFile(configPath, 'utf8'), '');

      await fakeCodex(1);
      writeConfigPatch(patch, REMOTE);
      assert.ok(!(await readFile(configPath, 'utf8')).includes('model_catalog_json'));
      assert.equal(existsSync(catalogPath), false);
    } finally {
      process.env['PATH'] = originalPath;
    }
  });
});

test('goose: legacy patch still removes after the upgrade', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const patch: ConfigPatchDef = { format: 'goose', configPath, providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' };
    writeConfigPatch(patch, 8377);
    assert.equal(isConfigPatchConnected(patch), true);
    assert.equal(removeConfigPatch(patch), true);
    assert.equal(await readFile(configPath, 'utf8'), '');
  });
});

test('goose: moving off the legacy proxy keeps the user\'s selection, not our alias', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const patch: ConfigPatchDef = { format: 'goose', configPath, providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' };
    await writeFile(configPath, 'GOOSE_PROVIDER: mine\nGOOSE_MODEL: a\n');
    writeConfigPatch(patch, 8377);
    writeConfigPatch(patch, LOCAL);
    assert.equal(parse(await readFile(configPath, 'utf8')).GOOSE_MODEL, 'deepseek-v3.2');
    removeConfigPatch(patch);
    assert.deepEqual(parse(await readFile(configPath, 'utf8')), { GOOSE_PROVIDER: 'mine', GOOSE_MODEL: 'a' });
  });
});

test('goose: an unread model list keeps the pick and the list, and takes the new gateway and key', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const provider = path.join(dir, 'custom_providers', 'custom_antseed.json');
    const patch: ConfigPatchDef = { format: 'goose', configPath, providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' };
    writeConfigPatch(patch, LOCAL);
    await writeFile(configPath, 'GOOSE_PROVIDER: custom_antseed\nGOOSE_MODEL: kimi-k2\n');
    writeConfigPatch(patch, { origin: 'https://gw.example.com', apiKey: 'new-key', models: [] });
    assert.equal(parse(await readFile(configPath, 'utf8')).GOOSE_MODEL, 'kimi-k2');
    const written = await readJson(provider);
    assert.equal(written.models.length, MODELS.length);
    assert.equal(written.base_url, 'https://gw.example.com/v1/chat/completions');
    assert.equal(written.headers.Authorization, 'Bearer new-key');
  });
});

test('droid: an unread model list keeps our entries and points them at the new gateway and key', async () => {
  await withDir(async (dir) => {
    const droid = path.join(dir, 'droid.json');
    const patch = { format: 'droid', configPath: droid, modelDisplayName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1', provider: 'generic-chat-completion-api' } as unknown as ConfigPatchDef;
    const mine = { model: 'mine', id: 'custom:mine', baseUrl: 'https://mine.example', apiKey: 'mine-key' };
    await writeFile(droid, JSON.stringify({ customModels: [mine] }));
    writeConfigPatch(patch, LOCAL);
    const selected = (await readJson(droid)).sessionDefaultSettings.model;
    writeConfigPatch(patch, { origin: 'https://gw.example.com', apiKey: 'new-key', models: [] });
    const config = await readJson(droid);
    assert.equal(config.sessionDefaultSettings.model, selected);
    assert.deepEqual(config.customModels.find((entry: any) => entry.id === 'custom:mine'), mine);
    const ours = config.customModels.filter((entry: any) => entry.id !== 'custom:mine');
    assert.equal(ours.length, MODELS.length);
    for (const entry of ours) {
      assert.equal(entry.baseUrl, 'https://gw.example.com/v1');
      assert.equal(entry.apiKey, 'new-key');
    }
  });
});

test('claude-code: bearer key, model pick preserved, removal restores (and legacy → gateway migration)', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const original = { model: 'opus', env: { FOO: 'bar' } };
    await writeFile(configPath, JSON.stringify(original), 'utf8');
    const patch: ConfigPatchDef = { format: 'claude-code', configPath, providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}' };

    writeConfigPatch(patch, 8377);
    assert.equal((await readJson(configPath))['model'], 'antseed');

    writeConfigPatch(patch, REMOTE);
    let config = await readJson(configPath);
    assert.equal(config['env']['ANTHROPIC_BASE_URL'], 'https://gw.example.com');
    assert.equal(config['env']['ANTHROPIC_AUTH_TOKEN'], KEY);
    assert.equal(config['env']['ANTHROPIC_API_KEY'], '');
    assert.equal(config['model'], 'kimi-k2');
    assert.ok(!(await readFile(`${configPath}.antseed.state.json`, 'utf8')).includes(KEY));

    config['model'] = 'deepseek-v3.2';
    await writeFile(configPath, JSON.stringify(config), 'utf8');
    writeConfigPatch(patch, REMOTE);
    assert.equal((await readJson(configPath))['model'], 'deepseek-v3.2');

    assert.equal(removeConfigPatch(patch), true);
    assert.deepEqual(await readJson(configPath), original);
  });
});

test('t3code: remote instance is owned via the source header and removable', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const patch: ConfigPatchDef = {
      format: 't3code', configPath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}',
    };
    writeConfigPatch(patch, REMOTE);
    const config = await readJson(configPath);
    const env = Object.fromEntries((config['providerInstances']['antseed']['environment'] as Array<{ name: string; value: string }>)
      .map((v) => [v.name, v.value]));
    assert.equal(env['ANTHROPIC_BASE_URL'], 'https://gw.example.com');
    assert.equal(env['ANTHROPIC_AUTH_TOKEN'], KEY);
    assert.equal(env['ANTHROPIC_API_KEY'], '');
    assert.deepEqual(config['providerInstances']['antseed']['config']['customModels'], MODELS.map((m) => m.id));
    assert.equal(isConfigPatchConnected(patch), true);
    assert.equal(removeConfigPatch(patch), true);
    assert.equal((await readJson(configPath))['providerInstances'], undefined);
  });
});

test('droid: one entry per model with key; pick survives; legacy entry migrated; removal restores', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const original = { sessionDefaultSettings: { model: 'custom:Local-0' }, customModels: [{ model: 'local', id: 'custom:Local-0' }] };
    await writeFile(configPath, JSON.stringify(original), 'utf8');
    const patch: ConfigPatchDef = {
      format: 'droid', configPath, providerKey: 'antseed', providerName: 'Antseed Auto', baseURL: 'http://localhost:{buyerPort}/v1', originator: 'droid',
    };
    writeConfigPatch(patch, 8377);
    writeConfigPatch(patch, LOCAL);
    let config = await readJson(configPath);
    const managed = config['customModels'].slice(1) as Array<Record<string, unknown>>;
    assert.equal(config['customModels'][0].model, 'local');
    assert.deepEqual(managed.map((m) => m['model']), MODELS.map((m) => m.id));
    assert.ok(managed.every((m) => m['apiKey'] === KEY && m['baseUrl'] === 'http://localhost:8379/v1'));
    assert.equal(config['sessionDefaultSettings']['model'], managed[0]!['id']);

    config['sessionDefaultSettings']['model'] = managed[2]!['id'];
    await writeFile(configPath, JSON.stringify(config), 'utf8');
    writeConfigPatch(patch, REMOTE);
    config = await readJson(configPath);
    const kimi = (config['customModels'] as Array<Record<string, unknown>>).find((m) => m['model'] === 'kimi-k2')!;
    assert.equal(config['sessionDefaultSettings']['model'], kimi['id']);
    assert.equal(kimi['baseUrl'], 'https://gw.example.com/v1');

    assert.equal(removeConfigPatch(patch), true);
    assert.deepEqual(await readJson(configPath), original);
  });
});

test('hermes: api_key and models; remote provider removable', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    await writeFile(configPath, 'model:\n  provider: other\n  default: x\n', 'utf8');
    const patch: ConfigPatchDef = { format: 'hermes', configPath, providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}/v1' };
    writeConfigPatch(patch, REMOTE);
    const config = parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(config['providers']['antseed']['api'], 'https://gw.example.com/v1');
    assert.equal(config['providers']['antseed']['api_key'], KEY);
    assert.deepEqual(Object.keys(config['providers']['antseed']['models']), MODELS.map((m) => m.id));
    assert.equal(config['model']['provider'], 'antseed');
    assert.equal(config['model']['default'], 'kimi-k2');
    assert.equal(isConfigPatchConnected(patch), true);
    assert.equal(removeConfigPatch(patch), true);
    const after = parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(after['providers']?.['antseed'], undefined);
    assert.equal(after['model']?.['provider'], 'other');
    assert.equal(after['model']?.['default'], 'x');
  });
});

test('zed: every model listed, user pick kept', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const patch: ConfigPatchDef = {
      format: 'zed', configPath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1',
    };
    await writeFile(configPath, JSON.stringify({ agent: { default_model: { provider: 'Antseed', model: 'qwen3-coder' } } }), 'utf8');
    writeConfigPatch(patch, LOCAL);
    const config = await readJson(configPath);
    assert.equal(config['language_models']['openai_compatible']['Antseed']['api_url'], 'http://localhost:8379/v1');
    assert.deepEqual(
      config['language_models']['openai_compatible']['Antseed']['available_models'].map((m: { name: string }) => m.name),
      MODELS.map((m) => m.id),
    );
    assert.deepEqual(config['agent']['default_model'], { provider: 'Antseed', model: 'qwen3-coder' });
  });
});

test('claude-desktop: gateway key is written as inferenceGatewayApiKey', async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, 'Claude'), { recursive: true });
    const patch: ConfigPatchDef = {
      format: 'claude-desktop',
      configPath: path.join(dir, 'Claude', 'claude_desktop_config.json'),
      thirdPartyDir: path.join(dir, 'Claude-3p'),
      baseURL: 'http://127.0.0.1:{claudeGatewayPort}',
    };
    writeConfigPatch(patch, REMOTE);
    const profile = (await readJson(path.join(dir, 'Claude-3p', 'configLibrary', '00000000-0000-4000-8000-0000a4753eed.json')));
    assert.equal(profile['inferenceGatewayApiKey'], KEY);
    assert.match(profile['inferenceGatewayBaseUrl'], /^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

test('disconnecting gives the user their own model selection back', async () => {
  await withDir(async (dir) => {
    const cases: Array<{ patch: ConfigPatchDef; file: string; seed: string; read: (raw: string) => unknown; expected: unknown }> = [
      {
        patch: { format: 'opencode', configPath: path.join(dir, 'opencode.json'), providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1', npm: '@ai-sdk/openai-compatible' } as ConfigPatchDef,
        file: 'opencode.json', seed: '{"model":"mine/a"}', read: (raw) => JSON.parse(raw).model, expected: 'mine/a',
      },
      {
        patch: { format: 'codex', configPath: path.join(dir, 'config.toml'), providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' } as ConfigPatchDef,
        file: 'config.toml', seed: 'model = "gpt-5"\nmodel_provider = "mine"\nmodel_context_window = 1000\n',
        read: (raw) => ['model = "gpt-5"', 'model_provider = "mine"', 'model_context_window = 1000'].every((line) => raw.includes(line)), expected: true,
      },
      {
        patch: { format: 'crush', configPath: path.join(dir, 'crush.json'), providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' } as ConfigPatchDef,
        file: 'crush.json', seed: '{"models":{"large":{"provider":"mine","model":"a"}}}', read: (raw) => JSON.parse(raw).models, expected: { large: { provider: 'mine', model: 'a' } },
      },
      {
        patch: { format: 'zed', configPath: path.join(dir, 'zed.json'), providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' } as ConfigPatchDef,
        file: 'zed.json', seed: '{"agent":{"default_model":{"provider":"mine","model":"a"}}}', read: (raw) => JSON.parse(raw).agent.default_model, expected: { provider: 'mine', model: 'a' },
      },
      {
        patch: { format: 'goose', configPath: path.join(dir, 'goose.yaml'), providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' } as ConfigPatchDef,
        file: 'goose.yaml', seed: 'GOOSE_PROVIDER: mine\nGOOSE_MODEL: a\n', read: (raw) => parse(raw), expected: { GOOSE_PROVIDER: 'mine', GOOSE_MODEL: 'a' },
      },
      {
        patch: { format: 'hermes', configPath: path.join(dir, 'hermes.yaml'), providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}/v1' } as ConfigPatchDef,
        file: 'hermes.yaml', seed: 'model:\n  default: a\n  provider: mine\n', read: (raw) => parse(raw), expected: { model: { default: 'a', provider: 'mine' } },
      },
      {
        patch: { format: 'hermes', configPath: path.join(dir, 'hermes-short.yaml'), providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}/v1' } as ConfigPatchDef,
        file: 'hermes-short.yaml', seed: 'model: a\n', read: (raw) => parse(raw), expected: { model: 'a' },
      },
    ];
    for (const { patch, file, seed, read, expected } of cases) {
      const filePath = path.join(dir, file);
      await writeFile(filePath, seed);
      writeConfigPatch(patch, LOCAL);
      // A relaunch re-applies the patch; the saved selection must survive it.
      writeConfigPatch(patch, LOCAL);
      assert.ok(isConfigPatchConnected(patch), `${patch.format} connected`);
      removeConfigPatch(patch);
      assert.deepEqual(read(await readFile(filePath, 'utf8')), expected, `${patch.format} restored`);
      assert.equal(existsSync(`${filePath}.antseed.selection.json`), false);
    }
  });
});

test('a model the user picks elsewhere while connected is not overwritten on disconnect', async () => {
  await withDir(async (dir) => {
    const filePath = path.join(dir, 'opencode.json');
    const patch = { format: 'opencode', configPath: filePath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1', npm: '@ai-sdk/openai-compatible' } as ConfigPatchDef;
    await writeFile(filePath, '{"model":"mine/a"}');
    writeConfigPatch(patch, LOCAL);
    const config = await readJson(filePath);
    config.model = 'other/b';
    await writeFile(filePath, JSON.stringify(config));
    removeConfigPatch(patch);
    assert.equal((await readJson(filePath)).model, 'other/b');
  });
});

test('pi and GooeyPi share the selection: it returns once both are gone, in either order', async () => {
  for (const order of [['pi', 'gooeypi'], ['gooeypi', 'pi']]) {
    await withDir(async (dir) => {
      const models = path.join(dir, 'models.json');
      const settings = path.join(dir, 'settings.json');
      const patches: Record<string, ConfigPatchDef> = {
        pi: { format: 'pi', configPath: models, settingsPath: settings, providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}/v1', api: 'openai-responses' } as ConfigPatchDef,
        gooeypi: { format: 'pi', configPath: models, settingsPath: settings, providerKey: 'antseed-gooeypi', baseURL: 'http://localhost:{buyerPort}/v1', api: 'openai-responses' } as ConfigPatchDef,
      };
      await writeFile(settings, '{"defaultProvider":"mine","defaultModel":"a"}');
      writeConfigPatch(patches.pi!, LOCAL);
      writeConfigPatch(patches.gooeypi!, LOCAL);
      removeConfigPatch(patches[order[0]!]!);
      removeConfigPatch(patches[order[1]!]!);
      const after = await readJson(settings);
      assert.equal(after.defaultProvider, 'mine', order.join(' then '));
      assert.equal(after.defaultModel, 'a');
    });
  }
});

test('codex: a catalog rejected on a later refresh leaves no reference to the deleted file', { skip: process.platform === 'win32' }, async () => {
  await withDir(async (dir) => {
    const bin = path.join(dir, 'bin');
    await mkdir(bin);
    const codex = path.join(bin, 'codex');
    const fake = (rejecting: boolean) => `#!/bin/sh
if [ "$3" = "--bundled" ]; then echo '{"models":[{"base_instructions":"be good","truncation_policy":{"mode":"tokens","limit":1}}]}'; exit 0; fi
exit ${rejecting ? 1 : 0}
`;
    await writeFile(codex, fake(false), { mode: 0o755 });
    const previousPath = process.env['PATH'];
    process.env['PATH'] = `${bin}${path.delimiter}${previousPath ?? ''}`;
    try {
      const configPath = path.join(dir, 'config.toml');
      const patch = { format: 'codex', configPath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' } as ConfigPatchDef;
      writeConfigPatch(patch, LOCAL);
      const applied = (await readFile(configPath, 'utf8')).includes('model_catalog_json');
      await writeFile(codex, fake(true), { mode: 0o755 });
      writeConfigPatch(patch, LOCAL);
      const after = await readFile(configPath, 'utf8');
      assert.equal(after.includes('model_catalog_json'), false, `applied first: ${String(applied)}`);
      assert.equal(existsSync(path.join(dir, 'antseed-models.json')), false);
    } finally {
      process.env['PATH'] = previousPath;
    }
  });
});

test('a refresh with no models keeps the way back to the user\'s own default', async () => {
  await withDir(async (dir) => {
    const droid = path.join(dir, 'droid.json');
    const droidPatch = { format: 'droid', configPath: droid, modelDisplayName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1', provider: 'generic-chat-completion-api' } as unknown as ConfigPatchDef;
    await writeFile(droid, JSON.stringify({ sessionDefaultSettings: { model: 'mine' } }));
    writeConfigPatch(droidPatch, LOCAL);
    writeConfigPatch(droidPatch, { ...LOCAL, models: [] });
    removeConfigPatch(droidPatch);
    assert.equal((await readJson(droid)).sessionDefaultSettings.model, 'mine');

    const claude = path.join(dir, 'claude.json');
    const claudePatch = { format: 'claude-code', configPath: claude, baseURL: 'http://localhost:{buyerPort}' } as unknown as ConfigPatchDef;
    await writeFile(claude, JSON.stringify({ model: 'opus' }));
    writeConfigPatch(claudePatch, LOCAL);
    writeConfigPatch(claudePatch, { ...LOCAL, models: [] });
    removeConfigPatch(claudePatch);
    assert.equal((await readJson(claude)).model, 'opus');
  });
});

test('codex: a custom model catalog comes back on disconnect and when ours is rejected', { skip: process.platform === 'win32' }, async () => {
  await withDir(async (dir) => {
    const bin = path.join(dir, 'bin');
    await mkdir(bin);
    const fake = (code: number) => writeFile(path.join(bin, 'codex'), `#!/bin/sh
if [ "$3" = "--bundled" ]; then echo '{"models":[{"base_instructions":"be good","truncation_policy":{"mode":"tokens","limit":1}}]}'; exit 0; fi
exit ${code}
`, { mode: 0o755 });
    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${bin}${path.delimiter}${originalPath}`;
    try {
      const configPath = path.join(dir, 'config.toml');
      const patch = { format: 'codex', configPath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' } as ConfigPatchDef;
      await writeFile(configPath, 'model_catalog_json = "my-models.json"\n');
      await fake(0);
      writeConfigPatch(patch, LOCAL);
      assert.ok((await readFile(configPath, 'utf8')).includes('model_catalog_json = "antseed-models.json"'));
      removeConfigPatch(patch);
      assert.ok((await readFile(configPath, 'utf8')).includes('model_catalog_json = "my-models.json"'));

      await fake(1);
      writeConfigPatch(patch, LOCAL);
      assert.ok((await readFile(configPath, 'utf8')).includes('model_catalog_json = "my-models.json"'));
    } finally {
      process.env['PATH'] = originalPath;
    }
  });
});

test('an unread model list keeps every catalog and selection, and takes the new gateway and key', async () => {
  await withDir(async (dir) => {
    const unread: ConfigPatchTarget = { origin: 'https://gw.example.com', apiKey: 'antseed_new_key', models: [] };
    const cases: Array<{ patch: ConfigPatchDef; file: string; read: (raw: string) => any; catalog: (config: any) => unknown; picked: (config: any) => unknown }> = [
      {
        patch: { format: 'opencode', configPath: path.join(dir, 'opencode.json'), providerKey: 'antseed', providerName: 'Antseed', npm: '@ai-sdk/openai-compatible', baseURL: 'http://localhost:{buyerPort}/v1' } as ConfigPatchDef,
        file: 'opencode.json', read: JSON.parse,
        catalog: (config) => Object.keys(config.provider.antseed.models), picked: (config) => config.model,
      },
      {
        patch: { format: 'crush', configPath: path.join(dir, 'crush.json'), providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' } as ConfigPatchDef,
        file: 'crush.json', read: JSON.parse,
        catalog: (config) => config.providers.antseed.models.map((model: { id: string }) => model.id), picked: (config) => config.models.large.model,
      },
      {
        patch: { format: 'zed', configPath: path.join(dir, 'zed.json'), providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' } as ConfigPatchDef,
        file: 'zed.json', read: JSON.parse,
        catalog: (config) => config.language_models.openai_compatible.Antseed.available_models.map((model: { name: string }) => model.name), picked: (config) => config.agent.default_model.model,
      },
      {
        patch: { format: 'hermes', configPath: path.join(dir, 'hermes.yaml'), providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}/v1' } as ConfigPatchDef,
        file: 'hermes.yaml', read: parse,
        catalog: (config) => Object.keys(config.providers.antseed.models), picked: (config) => config.model.default,
      },
      {
        patch: { format: 't3code', configPath: path.join(dir, 't3.json'), providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}' } as ConfigPatchDef,
        file: 't3.json', read: JSON.parse,
        catalog: (config) => config.providerInstances.antseed.config.customModels, picked: () => undefined,
      },
    ];
    for (const { patch, file, read, catalog, picked } of cases) {
      writeConfigPatch(patch, LOCAL);
      const before = read(await readFile(path.join(dir, file), 'utf8'));
      writeConfigPatch(patch, unread);
      const raw = await readFile(path.join(dir, file), 'utf8');
      const after = read(raw);
      assert.deepEqual(catalog(after), MODELS.map((model) => model.id), patch.format);
      assert.equal(picked(after), picked(before), patch.format);
      assert.ok(raw.includes('gw.example.com'), `${patch.format} takes the new gateway`);
      if (patch.format !== 'zed') assert.ok(raw.includes('antseed_new_key'), `${patch.format} takes the new key`);
    }

    const modelsPath = path.join(dir, 'models.json');
    const settingsPath = path.join(dir, 'settings.json');
    const pi: ConfigPatchDef = { format: 'pi', configPath: modelsPath, settingsPath, providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}/v1', api: 'openai-completions' };
    writeConfigPatch(pi, LOCAL);
    const picked = (await readJson(settingsPath))['defaultModel'];
    writeConfigPatch(pi, unread);
    const provider = (await readJson(modelsPath))['providers']['antseed'];
    assert.deepEqual(provider['models'].map((model: { id: string }) => model.id), MODELS.map((model) => model.id));
    assert.equal(provider['apiKey'], 'antseed_new_key');
    assert.equal((await readJson(settingsPath))['defaultModel'], picked);
  });
});
