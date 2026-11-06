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
    assert.equal(after['model']?.['provider'], undefined);
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
