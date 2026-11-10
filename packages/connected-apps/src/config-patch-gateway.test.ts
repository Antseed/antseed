import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

import {
  configPatchBaseUrl,
  isConfigPatchConnected,
  removeConfigPatch,
  wslShareRoot,
  writeWslTargets,
  unescapeTomlBasicString,
  writeConfigPatch,
  type ConfigPatchDef,
  type ConfigPatchTarget,
} from './config-patch.js';
import { readWslTargetsForTool, saveWslTargetsForTool } from './wsl.js';

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
  // The whole IPv4 loopback range is this computer.
  assert.equal(configPatchBaseUrl('http://localhost:{buyerPort}/v1', { ...LOCAL, origin: 'http://127.0.0.2:9000' }, '172.29.32.1'), 'http://172.29.32.1:9000/v1');
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

test('codex: a context window set only inside a profile does not become a global one', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.toml');
    const original = 'model = "mine"\n\n[profiles.big]\nmodel_context_window = 500000\n';
    await writeFile(configPath, original, 'utf8');
    const patch: ConfigPatchDef = { format: 'codex', configPath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' };
    writeConfigPatch(patch, LOCAL);
    assert.equal(removeConfigPatch(patch), true);
    const after = await readFile(configPath, 'utf8');
    const beforeFirstTable = after.split('[')[0]!;
    assert.doesNotMatch(beforeFirstTable, /model_context_window/);
    assert.match(after, /\[profiles\.big\]\nmodel_context_window = 500000/);
  });
});

test('codex: a gateway model id with a newline or other control character stays one TOML line', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.toml');
    await writeFile(configPath, 'model = "mine"\n', 'utf8');
    const patch: ConfigPatchDef = { format: 'codex', configPath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' };
    const odd = 'odd\nmodel\t\u007f';
    writeConfigPatch(patch, { ...LOCAL, models: [{ id: odd }], defaultModel: odd });
    const connected = await readFile(configPath, 'utf8');
    assert.match(connected, /^model = "odd\\nmodel\\t\\u007f"$/m);
    assert.ok(!connected.split('\n').some((line) => line.startsWith('model"') || line === 'model\t\u007f"'));
    assert.equal(removeConfigPatch(patch), true);
    assert.equal((await readFile(configPath, 'utf8')).trim(), 'model = "mine"');
  });
});

test('codex: settings in other valid TOML forms come back as they were', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.toml');
    await writeFile(configPath, "model = 'mine'\nmodel_provider = 'theirs'\nmodel_context_window = 128_000 # roomy\nmodel_catalog_json = 'my-models.json'\n", 'utf8');
    const patch: ConfigPatchDef = { format: 'codex', configPath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' };
    writeConfigPatch(patch, LOCAL);
    const connected = await readFile(configPath, 'utf8');
    assert.match(connected, /model_provider = "antseed"/);
    assert.equal(removeConfigPatch(patch), true);
    const after = await readFile(configPath, 'utf8');
    assert.match(after, /^model_context_window = 128_000$/m);
    assert.match(after, /^model = "mine"$/m);
    assert.match(after, /^model_provider = "theirs"$/m);
    // Rewritten only when an installed Codex accepted our catalog; either way it's the user's value.
    assert.match(after, /^model_catalog_json = ["']my-models\.json["']$/m);
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

test('goose: a refresh whose config write fails puts the provider back, matching the kept selection', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const providerPath = path.join(dir, 'custom_providers', 'custom_antseed.json');
    await writeFile(configPath, 'keep_me: true\n', 'utf8');
    const patch: ConfigPatchDef = { format: 'goose', configPath, providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' };
    writeConfigPatch(patch, REMOTE);
    await chmod(configPath, 0o444);
    assert.throws(() => writeConfigPatch(patch, { origin: 'https://other.example.com', apiKey: 'antseed_other_key', models: [{ id: 'glm-5' }] }), /EACCES|permission/i);
    await chmod(configPath, 0o600);
    const config = parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(config['GOOSE_PROVIDER'], 'custom_antseed');
    assert.equal(config['GOOSE_MODEL'], 'kimi-k2');
    // The provider went back with the config: the old gateway, key and models
    // still match the model goose selects.
    const provider = JSON.parse(await readFile(providerPath, 'utf8'));
    assert.equal(provider.base_url, 'https://gw.example.com/v1/chat/completions');
    assert.equal(provider.headers.Authorization, `Bearer ${KEY}`);
    assert.ok(provider.models.some((model: { name: string }) => model.name === 'kimi-k2'));
    assert.equal(removeConfigPatch(patch), true);
    assert.deepEqual(parse(await readFile(configPath, 'utf8')), { keep_me: true });
    assert.equal(existsSync(providerPath), false);
  });
});

test('goose: a first connect whose provider file cannot be written leaves goose on its own provider', { skip: process.platform === 'win32' }, async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const providers = path.join(dir, 'custom_providers');
    await writeFile(configPath, 'GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: claude-sonnet\n', 'utf8');
    await mkdir(providers);
    await chmod(providers, 0o555);
    const patch: ConfigPatchDef = { format: 'goose', configPath, providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' };
    try {
      assert.throws(() => writeConfigPatch(patch, REMOTE), /EACCES|permission/i);
    } finally {
      await chmod(providers, 0o755);
    }
    const config = parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(config['GOOSE_PROVIDER'], 'anthropic');
    assert.equal(config['GOOSE_MODEL'], 'claude-sonnet');
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

      // Moving to the legacy proxy (one alias) drops the gateway's catalog.
      writeConfigPatch(patch, REMOTE);
      assert.equal(existsSync(catalogPath), true);
      writeConfigPatch(patch, 8377);
      assert.ok(!(await readFile(configPath, 'utf8')).includes('model_catalog_json'));
      assert.equal(existsSync(catalogPath), false);
      assert.equal(removeConfigPatch(patch), true);

      await fakeCodex(1);
      writeConfigPatch(patch, REMOTE);
      assert.ok(!(await readFile(configPath, 'utf8')).includes('model_catalog_json'));
      assert.equal(existsSync(catalogPath), false);
    } finally {
      process.env['PATH'] = originalPath;
    }
  });
});

test('goose: a custom_antseed provider the user already had comes back on disconnect', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const providerPath = path.join(dir, 'custom_providers', 'custom_antseed.json');
    await mkdir(path.dirname(providerPath), { recursive: true });
    const mine = '{"name":"custom_antseed","description":"mine","base_url":"https://mine.example"}\n';
    await writeFile(providerPath, mine, 'utf8');
    await writeFile(configPath, 'GOOSE_PROVIDER: custom_antseed\nGOOSE_MODEL: my-model\n', 'utf8');
    const patch: ConfigPatchDef = { format: 'goose', configPath, providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' };

    assert.equal(isConfigPatchConnected(patch), false);
    writeConfigPatch(patch, REMOTE);
    assert.equal(JSON.parse(await readFile(providerPath, 'utf8')).base_url, 'https://gw.example.com/v1/chat/completions');
    // A reconnect must not lose it either.
    writeConfigPatch(patch, REMOTE);
    assert.equal(isConfigPatchConnected(patch), true);

    // A failed config write leaves the user's provider saved, so the retry still restores both.
    await chmod(configPath, 0o444);
    assert.throws(() => removeConfigPatch(patch), /EACCES|permission/i);
    await chmod(configPath, 0o600);
    assert.equal(removeConfigPatch(patch), true);
    assert.equal(await readFile(providerPath, 'utf8'), mine);
    assert.deepEqual(parse(await readFile(configPath, 'utf8')), { GOOSE_PROVIDER: 'custom_antseed', GOOSE_MODEL: 'my-model' });
  });
});

test('goose: disconnecting without having connected leaves the user\'s own custom_antseed alone', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const providerPath = path.join(dir, 'custom_providers', 'custom_antseed.json');
    await mkdir(path.dirname(providerPath), { recursive: true });
    const mine = '{"name":"custom_antseed","description":"mine"}\n';
    await writeFile(providerPath, mine, 'utf8');
    await writeFile(configPath, 'GOOSE_PROVIDER: custom_antseed\nGOOSE_MODEL: my-model\n', 'utf8');
    const patch: ConfigPatchDef = { format: 'goose', configPath, providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' };

    removeConfigPatch(patch);
    assert.equal(await readFile(providerPath, 'utf8'), mine);
    assert.deepEqual(parse(await readFile(configPath, 'utf8')), { GOOSE_PROVIDER: 'custom_antseed', GOOSE_MODEL: 'my-model' });
  });
});

test('goose: a local endpoint of the user\'s own survives connect and disconnect', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const original = { GOOSE_PROVIDER: 'openai', GOOSE_MODEL: 'local-llm', OPENAI_HOST: 'http://localhost:11434', OPENAI_API_KEY: 'local-key' };
    await writeFile(configPath, Object.entries(original).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n', 'utf8');
    const patch: ConfigPatchDef = { format: 'goose', configPath, providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' };

    writeConfigPatch(patch, LOCAL);
    const connected = parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(connected['GOOSE_PROVIDER'], 'custom_antseed');
    assert.equal(connected['OPENAI_HOST'], original.OPENAI_HOST);
    assert.equal(connected['OPENAI_API_KEY'], original.OPENAI_API_KEY);

    assert.equal(removeConfigPatch(patch), true);
    assert.deepEqual(parse(await readFile(configPath, 'utf8')), original);
  });
});

test('files holding the gateway key are readable only by their owner', { skip: process.platform === 'win32' }, async () => {
  await withDir(async (dir) => {
    const mode = async (file: string) => (await stat(file)).mode & 0o777;
    const goose = path.join(dir, 'config.yaml');
    const goosePatch: ConfigPatchDef = { format: 'goose', configPath: goose, providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' };
    writeConfigPatch(goosePatch, LOCAL);
    assert.equal(await mode(path.join(dir, 'custom_providers', 'custom_antseed.json')), 0o600);

    // A file that was already readable by others is tightened, along with its backup.
    const models = path.join(dir, 'models.json');
    const settings = path.join(dir, 'settings.json');
    await writeFile(models, '{}\n', { mode: 0o644 });
    await chmod(models, 0o644);
    writeConfigPatch({ format: 'pi', configPath: models, settingsPath: settings, providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}/v1', api: 'openai-completions' }, LOCAL);
    assert.equal(await mode(models), 0o600);
    assert.equal(await mode(`${models}.antseed.bak`), 0o600);
  });
});

test('goose: moving from the gateway to the legacy proxy keeps the user\'s own selection for disconnect', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const providerPath = path.join(dir, 'custom_providers', 'custom_antseed.json');
    await writeFile(configPath, 'GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: claude-sonnet\n', 'utf8');
    const patch: ConfigPatchDef = { format: 'goose', configPath, providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' };
    writeConfigPatch(patch, LOCAL);
    writeConfigPatch(patch, 8377);
    assert.equal(existsSync(providerPath), false);
    assert.equal(removeConfigPatch(patch), true);
    assert.deepEqual(parse(await readFile(configPath, 'utf8')), { GOOSE_PROVIDER: 'anthropic', GOOSE_MODEL: 'claude-sonnet' });
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

test('claude-code: a refresh whose ownership record or config write fails is still undone by disconnect', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const original = { model: 'opus', env: { FOO: 'bar' } };
    const patch: ConfigPatchDef = { format: 'claude-code', configPath, providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}' };
    const moved: ConfigPatchTarget = { origin: 'https://other.example.com', apiKey: 'antseed_other_key', models: [{ id: 'glm-5' }] };
    for (const failing of [`${configPath}.antseed.state.json`, configPath]) {
      await writeFile(configPath, JSON.stringify(original), 'utf8');
      writeConfigPatch(patch, LOCAL);
      await chmod(failing, 0o444);
      assert.throws(() => writeConfigPatch(patch, moved), /EACCES|permission/i);
      await chmod(failing, 0o600);
      removeConfigPatch(patch);
      assert.deepEqual(await readJson(configPath), original, `restored after ${path.basename(failing)} failed`);
    }
  });
});

test('claude-code: several failed refreshes in a row still leave the settings on disk recognizable', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const original = { model: 'opus', env: { FOO: 'bar' } };
    await writeFile(configPath, JSON.stringify(original), 'utf8');
    const patch: ConfigPatchDef = { format: 'claude-code', configPath, providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}' };
    writeConfigPatch(patch, { origin: 'https://a.example.com', apiKey: 'antseed_key_a', models: [{ id: 'model-a' }] });
    await chmod(configPath, 0o444);
    for (const name of ['b', 'c']) {
      assert.throws(() => writeConfigPatch(patch, { origin: `https://${name}.example.com`, apiKey: `antseed_key_${name}`, models: [{ id: `model-${name}` }] }), /EACCES|permission/i);
    }
    await chmod(configPath, 0o600);
    removeConfigPatch(patch);
    assert.deepEqual(await readJson(configPath), original);
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

test('droid: a refresh to new models whose config write fails still leaves the old entries to disconnect', async () => {
  await withDir(async (dir) => {
    const droid = path.join(dir, 'droid.json');
    const patch = { format: 'droid', configPath: droid, modelDisplayName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1', provider: 'generic-chat-completion-api' } as unknown as ConfigPatchDef;
    const mine = { model: 'mine', id: 'custom:mine', baseUrl: 'https://mine.example', apiKey: 'mine-key' };
    await writeFile(droid, JSON.stringify({ customModels: [mine], sessionDefaultSettings: { model: 'custom:mine' } }));
    writeConfigPatch(patch, LOCAL);
    await chmod(droid, 0o444);
    assert.throws(() => writeConfigPatch(patch, { ...LOCAL, models: [{ id: 'brand-new' }] }), /EACCES|permission/i);
    await chmod(droid, 0o600);
    removeConfigPatch(patch);
    const config = await readJson(droid);
    assert.deepEqual(config.customModels, [mine]);
    assert.equal(config.sessionDefaultSettings.model, 'custom:mine');
  });
});

test('droid: moving off the legacy proxy while the model list is unreadable keeps the selection working', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const patch: ConfigPatchDef = { format: 'droid', configPath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' };
    await writeFile(configPath, JSON.stringify({ sessionDefaultSettings: { model: 'mine' } }), 'utf8');
    writeConfigPatch(patch, 8377);

    writeConfigPatch(patch, { ...LOCAL, models: [] });
    let config = await readJson(configPath);
    const selected = config['sessionDefaultSettings']['model'];
    const entry = config['customModels'].find((model: Record<string, unknown>) => model['id'] === selected);
    assert.ok(entry, 'the selected custom model still exists');
    assert.equal(entry['baseUrl'], 'http://localhost:8379/v1');
    assert.equal(entry['apiKey'], KEY);

    // The list comes back: the real models replace the old entry.
    writeConfigPatch(patch, LOCAL);
    config = await readJson(configPath);
    assert.deepEqual(config['customModels'].map((model: Record<string, unknown>) => model['model']), MODELS.map((model) => model.id));

    assert.equal(removeConfigPatch(patch), true);
    assert.equal((await readJson(configPath))['sessionDefaultSettings']['model'], 'mine');
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
    // A disconnect whose restoring write fails keeps the saved selection, so a retry still gives it back.
    for (const { patch, file, seed, read, expected } of cases) {
      const filePath = path.join(dir, file);
      await writeFile(filePath, seed);
      writeConfigPatch(patch, LOCAL);
      await chmod(filePath, 0o444);
      assert.throws(() => removeConfigPatch(patch), /EACCES|permission/i, `${patch.format} write fails`);
      assert.ok(existsSync(`${filePath}.antseed.selection.json`), `${patch.format} keeps its selection`);
      await chmod(filePath, 0o600);
      removeConfigPatch(patch);
      assert.deepEqual(read(await readFile(filePath, 'utf8')), expected, `${patch.format} restored on retry`);
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

test('pi and GooeyPi: reconnecting the one left after the other disconnects keeps the saved selection', async () => {
  await withDir(async (dir) => {
    const models = path.join(dir, 'models.json');
    const settings = path.join(dir, 'settings.json');
    const pi: ConfigPatchDef = { format: 'pi', configPath: models, settingsPath: settings, providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}/v1', api: 'openai-completions' };
    const gooeypi: ConfigPatchDef = { ...pi, providerKey: 'antseed-gooeypi' };
    await writeFile(settings, JSON.stringify({ defaultProvider: 'mine', defaultModel: 'my-model' }), 'utf8');

    writeConfigPatch(pi, LOCAL);
    writeConfigPatch(gooeypi, LOCAL);
    removeConfigPatch(gooeypi);
    writeConfigPatch(pi, LOCAL);
    removeConfigPatch(pi);

    const after = await readJson(settings);
    assert.equal(after['defaultProvider'], 'mine');
    assert.equal(after['defaultModel'], 'my-model');
  });
});

test('pi: a custom provider key does not save itself over the user\'s selection', async () => {
  await withDir(async (dir) => {
    const settings = path.join(dir, 'settings.json');
    const patch: ConfigPatchDef = { format: 'pi', configPath: path.join(dir, 'models.json'), settingsPath: settings, providerKey: 'my-gateway', baseURL: 'http://localhost:{buyerPort}/v1', api: 'openai-completions' };
    await writeFile(settings, JSON.stringify({ defaultProvider: 'mine', defaultModel: 'my-model' }), 'utf8');
    writeConfigPatch(patch, LOCAL);
    writeConfigPatch(patch, LOCAL);
    removeConfigPatch(patch);
    const after = await readJson(settings);
    assert.equal(after['defaultProvider'], 'mine');
    assert.equal(after['defaultModel'], 'my-model');
  });
});

test('pi: a provider of the user\'s own named antseed-something is left to them', async () => {
  await withDir(async (dir) => {
    const models = path.join(dir, 'models.json');
    const settings = path.join(dir, 'settings.json');
    const patch: ConfigPatchDef = { format: 'pi', configPath: models, settingsPath: settings, providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}/v1', api: 'openai-completions' };
    await writeFile(models, JSON.stringify({ providers: { 'antseed-personal': { baseUrl: 'http://mine' } } }), 'utf8');
    await writeFile(settings, JSON.stringify({ defaultProvider: 'antseed-personal', defaultModel: 'a' }), 'utf8');
    writeConfigPatch(patch, LOCAL);
    removeConfigPatch(patch);
    const after = await readJson(settings);
    assert.equal(after['defaultProvider'], 'antseed-personal');
    assert.equal(after['defaultModel'], 'a');
    assert.ok((await readJson(models))['providers']['antseed-personal']);
  });
});

test('wsl: a reconnect that cannot see a distro keeps its row for disconnect', { skip: process.platform === 'win32' }, async () => {
  await withDir(async (dir) => {
    const native = path.join(dir, 'opencode.json');
    await writeFile(native, '{}\n', 'utf8');
    const targetsFile = path.join(dir, 'wsl-targets.json');
    saveWslTargetsForTool(targetsFile, 'opencode', [{ tool: 'opencode', distro: 'Ubuntu', configPath: path.join(dir, 'gone', 'opencode.json'), host: '172.29.32.1', needsRelay: false }]);
    const patch = { format: 'opencode', configPath: native, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1', installProbe: 'opencode' } as ConfigPatchDef;
    // This machine finds no distros, as when the share is down.
    writeConfigPatch(patch, REMOTE, targetsFile);
    assert.deepEqual(readWslTargetsForTool(targetsFile, 'opencode').map((row) => row.distro), ['Ubuntu']);
  });
});

test('wsl: a share that does not answer is not taken as cleaned up', { skip: process.platform === 'win32' }, async () => {
  await withDir(async (dir) => {
    const native = path.join(dir, 'opencode.json');
    await writeFile(native, '{}\n', 'utf8');
    const gone = path.join(dir, 'no-such-share', 'opencode.json');
    const targetsFile = path.join(dir, 'wsl-targets.json');
    saveWslTargetsForTool(targetsFile, 'opencode', [{ tool: 'opencode', distro: 'Ubuntu', configPath: gone, host: '172.29.32.1', needsRelay: false }]);
    const patch = { format: 'opencode', configPath: native, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1', installProbe: 'opencode' } as ConfigPatchDef;
    assert.throws(() => removeConfigPatch(patch, targetsFile), /Could not reach WSL \(Ubuntu\)/);
    assert.equal(readWslTargetsForTool(targetsFile, 'opencode').length, 1);
  });
});

test('wslShareRoot finds the distro share', () => {
  assert.equal(wslShareRoot('\\\\wsl.localhost\\Ubuntu\\home\\me\\.config\\opencode\\opencode.json'), '\\\\wsl.localhost\\Ubuntu\\');
  assert.equal(wslShareRoot('/tmp/a/b.json'), '/tmp/a');
});

test('wsl: a distro that cannot be reached stays remembered and the disconnect says so', { skip: process.platform === 'win32' }, async () => {
  await withDir(async (dir) => {
    const native = path.join(dir, 'opencode.json');
    await writeFile(native, '{}\n', 'utf8');
    // A directory where the config should be: reading it fails, like an unavailable share.
    const unreachable = path.join(dir, 'unreachable.json');
    await mkdir(unreachable);
    const reachable = path.join(dir, 'reachable.json');
    await writeFile(reachable, JSON.stringify({ provider: { antseed: { name: 'Antseed' } } }), 'utf8');
    const targetsFile = path.join(dir, 'wsl-targets.json');
    const target = (distro: string, configPath: string) => ({ tool: 'opencode' as const, distro, configPath, host: '172.29.32.1', needsRelay: false });
    saveWslTargetsForTool(targetsFile, 'opencode', [target('Ubuntu', unreachable), target('Debian', reachable)]);
    const patch: ConfigPatchDef = { format: 'opencode', configPath: native, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1', installProbe: 'opencode' } as ConfigPatchDef;

    assert.throws(() => removeConfigPatch(patch, targetsFile), /Could not reach WSL \(Ubuntu\)/);
    assert.deepEqual(readWslTargetsForTool(targetsFile, 'opencode').map((row) => row.distro), ['Ubuntu']);
    assert.equal((await readJson(reachable))['provider']?.['antseed'], undefined);

    // Reachable again: the retry finishes and forgets it.
    await rm(unreachable, { recursive: true });
    await writeFile(unreachable, JSON.stringify({ provider: { antseed: { name: 'Antseed' } } }), 'utf8');
    removeConfigPatch(patch, targetsFile);
    assert.deepEqual(readWslTargetsForTool(targetsFile, 'opencode'), []);
    assert.equal((await readJson(unreachable))['provider']?.['antseed'], undefined);
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

test('wsl: every target is remembered before any is written, so a failure partway can still be undone', () => {
  const target = (distro: string) => ({ distro, configPath: `\\\\wsl.localhost\\${distro}\\home\\me\\.codex\\config.toml`, host: '172.20.0.1', needsRelay: true }) as never;
  const events: string[] = [];
  let saved: Array<{ distro: string }> = [];
  assert.throws(() => writeWslTargets([target('Ubuntu'), target('Debian')], {
    remembered: [target('Arch')],
    save: (rows) => { saved = rows as never; events.push('save'); },
    write: (t) => {
      const { distro } = t as { distro: string };
      if (distro === 'Debian') throw new Error('read-only');
      events.push(`write ${distro}`);
    },
  }), /read-only/);
  assert.deepEqual(events, ['save', 'write Ubuntu']);
  assert.deepEqual(saved.map((row) => row.distro), ['Arch', 'Ubuntu', 'Debian']);
});

test('TOML strings decode their own escapes, the eight-digit Unicode one included', () => {
  assert.equal(unescapeTomlBasicString('\\U00000061.json'), 'a.json');
  assert.equal(unescapeTomlBasicString('caf\\u00e9\\tx'), 'café\tx');
  assert.equal(unescapeTomlBasicString('C:\\\\models\\"x\\".json'), 'C:\\models"x".json');
  assert.equal(unescapeTomlBasicString('\\U0001F600'), '😀');
});
