import test from 'node:test';
import assert from 'node:assert/strict';
import { ANTSEED_MODEL_CONTEXT_WINDOW, ANTSEED_MODEL_MAX_OUTPUT_TOKENS } from '@antseed/protocol/service-api';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

import {
  CLAUDE_DESKTOP_PROFILE_ID,
  CLAUDE_GATEWAY_DEFAULT_PORT,
  applyConfigPatch,
  claudeDesktopPatchTargets,
  parseJsoncObject,
  readConfigPatch,
  removeConfigPatch,
  substituteBaseUrlHost,
  type ClaudeDesktopConfigPatchDef,
  type CodexConfigPatchDef,
  type ConfigPatchDef,
  type DroidConfigPatchDef,
  type OpencodeConfigPatchDef,
} from './config-patch.js';
import { DEFAULT_APP_PROFILES } from './defaults.js';

const PEER_ID = '0123456789abcdef0123456789abcdef01234567';

function makePatch(configPath: string): ConfigPatchDef {
  return {
    configPath,
    providerKey: 'antseed',
    npm: '@antseed/tool-provider',
    providerName: 'Antseed',
    baseURL: 'http://127.0.0.1:{buyerPort}/v1',
  };
}

function makeClaudeCodePatch(configPath: string): ConfigPatchDef {
  return {
    format: 'claude-code',
    configPath,
    providerKey: 'antseed',
    baseURL: 'http://localhost:{buyerPort}',
  };
}

function makeT3CodePatch(configPath: string): ConfigPatchDef {
  return {
    format: 't3code',
    configPath,
    providerKey: 'antseed',
    providerName: 'Antseed',
    baseURL: 'http://localhost:{buyerPort}',
  };
}

async function withTempConfig(fn: (dir: string, configPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-desktop-system-proxy-'));
  try {
    await fn(dir, path.join(dir, 'tool-config.jsonc'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('parseJsoncObject accepts comments and trailing commas without touching strings', () => {
  const parsed = parseJsoncObject(`
    {
      // line comment
      "url": "https://example.test/path//inside-string",
      "glob": "/* also inside string */",
      "items": ["one", "two",],
    }
  `, 'config.jsonc');

  assert.deepEqual(parsed, {
    url: 'https://example.test/path//inside-string',
    glob: '/* also inside string */',
    items: ['one', 'two'],
  });
});

test('applyConfigPatch patches JSONC configs and writes a backup before normalizing JSON', async () => {
  await withTempConfig(async (_dir, configPath) => {
    const original = `{
      // user setting comment
      "provider": {
        "existing": { "name": "Existing" },
      },
      "disabled_providers": ["antseed", "other",],
      "notes": "keep // literal text",
    }\n`;
    await writeFile(configPath, original, 'utf8');

    applyConfigPatch(makePatch(configPath), PEER_ID, 9456);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      provider: Record<string, {
        name?: string;
        npm?: string;
        options?: { baseURL?: string; apiKey?: string };
        models?: Record<string, {
          name: string;
          attachment?: boolean;
          modalities?: { input: string[]; output: string[] };
          limit: { context: number; output: number };
        }>;
      }>;
      model: string;
      disabled_providers?: string[];
      notes: string;
    };

    assert.equal(config.provider.existing?.name, 'Existing');
    assert.equal(config.provider.antseed?.name, 'Antseed');
    assert.equal(config.provider.antseed?.npm, '@antseed/tool-provider');
    assert.equal(config.provider.antseed?.options?.baseURL, 'http://127.0.0.1:9456/v1');
    assert.equal(config.provider.antseed?.options?.apiKey, 'antseed');
    assert.deepEqual(config.provider.antseed?.models, {
      antseed: {
        name: 'Antseed Auto',
        attachment: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: ANTSEED_MODEL_CONTEXT_WINDOW, output: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
      },
    });
    assert.equal(config.model, 'antseed/antseed');
    assert.deepEqual(config.disabled_providers, ['other']);
    assert.equal(config.notes, 'keep // literal text');

    assert.equal(await readFile(`${configPath}.antseed.bak`, 'utf8'), original);
  });
});

test('applyConfigPatch creates a new config file when one does not exist', async () => {
  await withTempConfig(async (_dir, configPath) => {
    applyConfigPatch(makePatch(configPath), PEER_ID, 8377);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      provider?: Record<string, unknown>;
      model?: string;
    };
    assert.ok(config.provider?.antseed);
    assert.equal(config.model, 'antseed/antseed');
    assert.equal(existsSync(`${configPath}.antseed.bak`), false);
  });
});

test('applyConfigPatch rejects routes without a routable peer ID', async () => {
  await withTempConfig(async (_dir, configPath) => {
    assert.throws(
      () => applyConfigPatch(makePatch(configPath), 'not-a-peer-id', 8377),
      /peer ID/,
    );
    assert.equal(existsSync(configPath), false);
  });
});

test('applyConfigPatch leaves malformed existing configs unchanged', async () => {
  await withTempConfig(async (_dir, configPath) => {
    const original = '{ "provider": { "broken": } }\n';
    await writeFile(configPath, original, 'utf8');

    assert.throws(
      () => applyConfigPatch(makePatch(configPath), PEER_ID, 8377),
      /Unable to parse JSONC config/,
    );

    assert.equal(await readFile(configPath, 'utf8'), original);
    assert.equal(await readFile(`${configPath}.antseed.bak`, 'utf8'), original);
  });
});

test('removeConfigPatch removes only the configured provider and matching model selection', async () => {
  await withTempConfig(async (_dir, configPath) => {
    await writeFile(configPath, JSON.stringify({
      provider: {
        existing: { name: 'Existing' },
      },
    }), 'utf8');
    const patch = makePatch(configPath);
    applyConfigPatch(patch, PEER_ID, 8377);

    assert.equal(removeConfigPatch(patch), true);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      provider: Record<string, unknown>;
      model?: string;
    };
    assert.ok(config.provider.existing);
    assert.equal(config.provider.antseed, undefined);
    assert.equal(config.model, undefined);
  });
});

test('removeConfigPatch is a no-op when the target file does not exist', async () => {
  await withTempConfig(async (_dir, configPath) => {
    assert.equal(removeConfigPatch(makePatch(configPath)), false);
  });
});

function makeDroidPatch(configPath: string): DroidConfigPatchDef {
  return {
    format: 'droid',
    configPath,
    providerKey: 'antseed',
    providerName: 'Antseed Auto',
    baseURL: 'http://127.0.0.1:{buyerPort}/v1',
    originator: 'droid',
  };
}

test('applyConfigPatch (droid) adds and selects the routed model while preserving user settings', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const original = {
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      sessionDefaultSettings: {
        model: 'custom:Local-Model-0',
        reasoningEffort: 'high',
      },
      customModels: [{
        model: 'local-model',
        displayName: 'Local Model',
        baseUrl: 'http://localhost:11434/v1',
        provider: 'generic-chat-completion-api',
      }],
    };
    await writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');

    const patch = makeDroidPatch(configPath);
    applyConfigPatch(patch, PEER_ID, 8377);
    applyConfigPatch(patch, PEER_ID, 9456);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(config['model'], 'gpt-5-codex');
    assert.deepEqual(config['sessionDefaultSettings'], {
      model: 'custom:Antseed-Auto-0',
      reasoningEffort: 'high',
    });
    assert.equal(config['reasoningEffort'], 'high');
    assert.deepEqual(config['customModels'][0], original.customModels[0]);
    assert.deepEqual(config['customModels'][1], {
      model: 'antseed',
      id: 'custom:Antseed-Auto-0',
      displayName: 'Antseed Auto',
      baseUrl: 'http://127.0.0.1:9456/v1',
      provider: 'generic-chat-completion-api',
      maxOutputTokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS,
      extraHeaders: {
        originator: 'droid',
      },
    });
    assert.ok(existsSync(`${configPath}.antseed.state.json`));
    assert.ok(existsSync(`${configPath}.antseed.bak`));

    assert.equal(removeConfigPatch(patch), true);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), original);
    assert.equal(existsSync(`${configPath}.antseed.state.json`), false);
  });
});

test('applyConfigPatch (droid) refuses to replace an existing antseed custom model', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const original = `${JSON.stringify({
      model: 'antseed',
      customModels: [{
        model: 'antseed',
        displayName: 'User Antseed',
        baseUrl: 'https://example.test/v1',
        provider: 'generic-chat-completion-api',
      }],
    }, null, 2)}\n`;
    await writeFile(configPath, original, 'utf8');

    assert.throws(
      () => applyConfigPatch(makeDroidPatch(configPath), PEER_ID, 8377),
      /already defines a custom model named antseed/,
    );
    assert.equal(await readFile(configPath, 'utf8'), original);
    assert.equal(existsSync(`${configPath}.antseed.state.json`), false);
  });
});

test('removeConfigPatch (droid) removes a config created entirely by Antseed', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const patch = makeDroidPatch(configPath);

    applyConfigPatch(patch, PEER_ID, 8377);
    assert.ok(existsSync(configPath));
    assert.equal(removeConfigPatch(patch), true);
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(`${configPath}.antseed.state.json`), false);
  });
});

test('removeConfigPatch (droid) preserves a model the user selected while connected', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const patch = makeDroidPatch(configPath);
    await writeFile(configPath, '{"model":"gpt-5-codex"}\n', 'utf8');
    applyConfigPatch(patch, PEER_ID, 8377);

    const connected = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    connected['sessionDefaultSettings']['model'] = 'claude-sonnet-4-5';
    await writeFile(configPath, `${JSON.stringify(connected, null, 2)}\n`, 'utf8');

    assert.equal(removeConfigPatch(patch), true);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      model: 'gpt-5-codex',
      sessionDefaultSettings: {
        model: 'claude-sonnet-4-5',
      },
    });
  });
});

test('removeConfigPatch (droid) restores the prior default after Droid normalizes settings', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const patch = makeDroidPatch(configPath);
    await writeFile(configPath, '{"model":"gpt-5-codex"}\n', 'utf8');
    applyConfigPatch(patch, PEER_ID, 8377);

    const connected = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    delete connected['model'];
    connected['customModels'][0]['index'] = 0;
    connected['sessionDefaultSettings'] = {
      model: 'custom:Antseed-Auto-0',
      reasoningEffort: 'none',
    };
    await writeFile(configPath, `${JSON.stringify(connected, null, 2)}\n`, 'utf8');

    assert.equal(removeConfigPatch(patch), true);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      model: 'gpt-5-codex',
      sessionDefaultSettings: {
        reasoningEffort: 'none',
      },
    });
  });
});

test('removeConfigPatch (droid) restores version 1 state after Droid normalization', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const patch = makeDroidPatch(configPath);
    await writeFile(configPath, `${JSON.stringify({
      customModels: [{
        model: 'antseed',
        id: 'custom:Antseed-Auto-0',
        displayName: 'Antseed Auto',
        baseUrl: 'http://127.0.0.1:8377/v1',
        provider: 'generic-chat-completion-api',
      }],
      sessionDefaultSettings: {
        model: 'custom:Antseed-Auto-0',
      },
    }, null, 2)}\n`, 'utf8');
    await writeFile(`${configPath}.antseed.state.json`, `${JSON.stringify({
      version: 1,
      configExisted: true,
      customModelsPresent: false,
      modelPresent: true,
      modelValue: 'gpt-5-codex',
    }, null, 2)}\n`, 'utf8');

    assert.equal(removeConfigPatch(patch), true);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      model: 'gpt-5-codex',
    });
  });
});

function makeCodexPatch(configPath: string): ConfigPatchDef {
  return {
    format: 'codex',
    configPath,
    providerKey: 'antseed',
    providerName: 'Antseed',
    baseURL: 'http://127.0.0.1:{buyerPort}/v1',
  };
}

test('applyConfigPatch (codex) sets top-level keys before tables and appends a managed provider table', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.toml');
    const original = [
      '# user comment',
      'model = "gpt-5"',
      '',
      '[mcp_servers.docs]',
      'command = "docs-server"',
      '',
    ].join('\n');
    await writeFile(configPath, original, 'utf8');

    applyConfigPatch(makeCodexPatch(configPath), PEER_ID, 9456);

    const raw = await readFile(configPath, 'utf8');
    const lines = raw.split('\n');
    const firstTable = lines.findIndex((line) => line.startsWith('['));
    assert.ok(lines.indexOf('model_provider = "antseed"') < firstTable);
    assert.ok(lines.indexOf('model = "antseed"') < firstTable);
    assert.ok(lines.indexOf(`model_context_window = ${ANTSEED_MODEL_CONTEXT_WINDOW}`) < firstTable);
    assert.equal(lines[0], '# user comment');
    assert.equal(lines.filter((line) => /^\s*model\s*=/.test(line)).length, 1);
    assert.ok(raw.includes('[mcp_servers.docs]'));
    assert.ok(raw.includes('[model_providers.antseed]'));
    assert.ok(raw.includes('name = "Antseed"'));
    assert.ok(raw.includes('base_url = "http://127.0.0.1:9456/v1"'));
    assert.ok(raw.includes('wire_api = "responses"'));
    assert.equal(await readFile(`${configPath}.antseed.bak`, 'utf8'), original);
  });
});

test('applyConfigPatch (codex) creates the config file and replaces a previous managed table', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.toml');
    applyConfigPatch(makeCodexPatch(configPath), PEER_ID, 8377);
    applyConfigPatch(makeCodexPatch(configPath), PEER_ID, 8378);

    const raw = await readFile(configPath, 'utf8');
    assert.equal(raw.split('[model_providers.antseed]').length, 2);
    assert.ok(raw.includes('model = "antseed"'));
    assert.ok(raw.includes('base_url = "http://127.0.0.1:8378/v1"'));
    assert.ok(!raw.includes('8377'));
  });
});

test('removeConfigPatch (codex) removes the managed table and model selection but keeps user tables', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.toml');
    await writeFile(configPath, '[mcp_servers.docs]\ncommand = "docs-server"\n', 'utf8');
    const patch = makeCodexPatch(configPath);
    applyConfigPatch(patch, PEER_ID, 8377);

    assert.equal(removeConfigPatch(patch), true);

    const raw = await readFile(configPath, 'utf8');
    assert.ok(raw.includes('[mcp_servers.docs]'));
    assert.ok(!raw.includes('model_provider'));
    assert.ok(!raw.includes('model = "antseed"'));
    assert.ok(!raw.includes('model_context_window'));
    assert.ok(!raw.includes('[model_providers.antseed]'));

    assert.equal(removeConfigPatch(patch), false);
  });
});

test('removeConfigPatch (codex) keeps a model_provider selection it does not own', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.toml');
    await writeFile(configPath, 'model_provider = "ollama"\nmodel = "llama3"\n', 'utf8');

    assert.equal(removeConfigPatch(makeCodexPatch(configPath)), false);
    assert.equal(await readFile(configPath, 'utf8'), 'model_provider = "ollama"\nmodel = "llama3"\n');
  });
});

function makePiPatch(modelsPath: string, settingsPath: string): ConfigPatchDef {
  return {
    format: 'pi',
    configPath: modelsPath,
    settingsPath,
    providerKey: 'antseed',
    baseURL: 'http://127.0.0.1:{buyerPort}/v1',
    api: 'openai-responses',
    originator: 'pi',
  };
}

test('applyConfigPatch (pi) writes the provider into models.json and the default selection into settings.json', async () => {
  await withTempConfig(async (dir) => {
    const modelsPath = path.join(dir, 'models.json');
    const settingsPath = path.join(dir, 'settings.json');
    await writeFile(modelsPath, JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1' } } }), 'utf8');
    await writeFile(settingsPath, JSON.stringify({ theme: 'dark' }), 'utf8');

    applyConfigPatch(makePiPatch(modelsPath, settingsPath), PEER_ID, 9456);

    const models = JSON.parse(await readFile(modelsPath, 'utf8')) as {
      providers: Record<string, { baseUrl?: string; api?: string; apiKey?: string; headers?: Record<string, string>; models?: Array<{ id: string; name: string; contextWindow: number; maxTokens: number }> }>;
    };
    assert.ok(models.providers.ollama);
    assert.equal(models.providers.antseed?.baseUrl, 'http://127.0.0.1:9456/v1');
    assert.equal(models.providers.antseed?.api, 'openai-responses');
    assert.equal(models.providers.antseed?.apiKey, 'antseed');
    assert.deepEqual(models.providers.antseed?.headers, { originator: 'pi' });
    assert.deepEqual(models.providers.antseed?.models, [
      { id: 'antseed', name: 'Antseed Auto', contextWindow: ANTSEED_MODEL_CONTEXT_WINDOW, maxTokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
    ]);

    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    assert.equal(settings['theme'], 'dark');
    assert.equal(settings['defaultProvider'], 'antseed');
    assert.equal(settings['defaultModel'], 'antseed');
  });
});

test('removeConfigPatch (pi) removes only the managed provider and matching default selection', async () => {
  await withTempConfig(async (dir) => {
    const modelsPath = path.join(dir, 'models.json');
    const settingsPath = path.join(dir, 'settings.json');
    const patch = makePiPatch(modelsPath, settingsPath);
    applyConfigPatch(patch, PEER_ID, 8377);

    assert.equal(removeConfigPatch(patch), true);

    const models = JSON.parse(await readFile(modelsPath, 'utf8')) as { providers?: Record<string, unknown> };
    assert.equal(models.providers?.['antseed'], undefined);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    assert.equal(settings['defaultProvider'], undefined);
    assert.equal(settings['defaultModel'], undefined);

    assert.equal(removeConfigPatch(patch), false);
  });
});

test('applyConfigPatch writes only the routed-model alias across formats', async () => {
  await withTempConfig(async (dir, configPath) => {
    applyConfigPatch(makePatch(configPath), PEER_ID, 8377);
    const opencode = JSON.parse(await readFile(configPath, 'utf8')) as { model?: string };
    assert.equal(opencode.model, 'antseed/antseed');

    const codexPath = path.join(dir, 'config.toml');
    applyConfigPatch(makeCodexPatch(codexPath), PEER_ID, 8377);
    const codexRaw = await readFile(codexPath, 'utf8');
    assert.ok(codexRaw.includes('model = "antseed"'));
    assert.ok(!codexRaw.includes(`${PEER_ID}@`));

    const modelsPath = path.join(dir, 'models.json');
    const settingsPath = path.join(dir, 'settings.json');
    applyConfigPatch(makePiPatch(modelsPath, settingsPath), PEER_ID, 8377);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    assert.equal(settings['defaultModel'], 'antseed');
    const models = JSON.parse(await readFile(modelsPath, 'utf8')) as {
      providers: Record<string, { models?: Array<{ id: string }> }>;
    };
    // Model selection lives in the desktop route selector (floating pill /
    // AI VPN); tool configs expose only the alias the buyer resolves per request.
    assert.deepEqual(models.providers.antseed?.models?.map((entry) => entry.id), ['antseed']);
  });
});

test('removeConfigPatch (pi) keeps a default selection it does not own', async () => {
  await withTempConfig(async (dir) => {
    const modelsPath = path.join(dir, 'models.json');
    const settingsPath = path.join(dir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude' }), 'utf8');

    assert.equal(removeConfigPatch(makePiPatch(modelsPath, settingsPath)), false);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    assert.equal(settings['defaultProvider'], 'anthropic');
    assert.equal(settings['defaultModel'], 'claude');
  });
});

// --- Crush ---

function makeCrushPatch(configPath: string): ConfigPatchDef {
  return {
    format: 'crush',
    configPath,
    providerKey: 'antseed',
    providerName: 'Antseed',
    baseURL: 'http://127.0.0.1:{buyerPort}/v1',
  };
}

test('applyConfigPatch (crush) writes an openai-compat provider and the large/small selections', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'crush.json');
    await writeFile(configPath, JSON.stringify({ options: { debug: true } }), 'utf8');

    applyConfigPatch(makeCrushPatch(configPath), PEER_ID, 8377);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.deepEqual(config['options'], { debug: true });
    const provider = config['providers']['antseed'];
    assert.equal(provider['type'], 'openai-compat');
    assert.equal(provider['base_url'], 'http://127.0.0.1:8377/v1');
    assert.deepEqual(
      provider['models'].map((model: Record<string, unknown>) => model['id']),
      ['antseed'],
    );
    assert.ok(provider['models'].every((model: Record<string, unknown>) => model['context_window'] === ANTSEED_MODEL_CONTEXT_WINDOW));
    assert.ok(provider['models'].every((model: Record<string, unknown>) => model['default_max_tokens'] === ANTSEED_MODEL_MAX_OUTPUT_TOKENS));
    assert.deepEqual(config['models']['large'], { provider: 'antseed', model: 'antseed' });
    assert.deepEqual(config['models']['small'], { provider: 'antseed', model: 'antseed' });
    assert.ok(existsSync(`${configPath}.antseed.bak`));
  });
});

test('removeConfigPatch (crush) removes only the managed provider and its selections', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'crush.json');
    await writeFile(configPath, JSON.stringify({
      providers: {
        antseed: { type: 'openai-compat' },
        deepseek: { type: 'openai-compat' },
      },
      models: {
        large: { provider: 'antseed', model: 'antseed' },
        small: { provider: 'deepseek', model: 'deepseek-chat' },
      },
    }), 'utf8');

    assert.equal(removeConfigPatch(makeCrushPatch(configPath)), true);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.deepEqual(Object.keys(config['providers']), ['deepseek']);
    assert.equal(config['models']['large'], undefined);
    assert.deepEqual(config['models']['small'], { provider: 'deepseek', model: 'deepseek-chat' });
  });
});

// --- goose ---

function makeGoosePatch(configPath: string): ConfigPatchDef {
  return {
    format: 'goose',
    configPath,
    providerKey: 'openai',
    baseURL: 'http://localhost:{buyerPort}',
  };
}

test('applyConfigPatch (goose) sets env-style keys while keeping user lines', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    await writeFile(configPath, '# my goose setup\nGOOSE_MODE: smart_approve\nGOOSE_MODEL: gpt-4o\n', 'utf8');

    applyConfigPatch(makeGoosePatch(configPath), PEER_ID, 8377);

    const raw = await readFile(configPath, 'utf8');
    const lines = raw.split('\n');
    assert.equal(lines[0], '# my goose setup');
    assert.equal(lines[1], 'GOOSE_MODE: smart_approve');
    assert.ok(lines.includes('GOOSE_PROVIDER: "openai"'));
    assert.ok(lines.includes('GOOSE_MODEL: "antseed"'));
    assert.ok(lines.includes('OPENAI_HOST: "http://localhost:8377"'));
    assert.ok(lines.includes('OPENAI_API_KEY: "antseed"'));
    assert.equal(lines.filter((line) => line.startsWith('GOOSE_MODEL')).length, 1);
    assert.ok(existsSync(`${configPath}.antseed.bak`));
  });
});

test('removeConfigPatch (goose) removes only keys the patch owns', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    await writeFile(configPath, [
      'GOOSE_MODE: smart_approve',
      'GOOSE_PROVIDER: "openai"',
      'GOOSE_MODEL: "antseed"',
      'OPENAI_HOST: "http://localhost:8377"',
      'OPENAI_API_KEY: "antseed"',
    ].join('\n') + '\n', 'utf8');

    assert.equal(removeConfigPatch(makeGoosePatch(configPath)), true);
    const raw = await readFile(configPath, 'utf8');
    assert.equal(raw, 'GOOSE_MODE: smart_approve\n');
  });
});

test('removeConfigPatch (goose) keeps a provider selection it does not own', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    await writeFile(configPath, 'GOOSE_PROVIDER: "openai"\nGOOSE_MODEL: "gpt-4o"\nOPENAI_HOST: "https://api.openai.com"\n', 'utf8');

    assert.equal(removeConfigPatch(makeGoosePatch(configPath)), false);
    const raw = await readFile(configPath, 'utf8');
    assert.ok(raw.includes('GOOSE_MODEL: "gpt-4o"'));
    assert.ok(raw.includes('OPENAI_HOST: "https://api.openai.com"'));
  });
});

// --- Claude Code ---

test('Claude Code patch routes through the AI VPN alias and restores managed settings', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    await writeFile(configPath, JSON.stringify({
      model: 'sonnet',
      env: {
        DISABLE_AUTO_COMPACT: '1',
        ANTHROPIC_API_KEY: 'user-key',
      },
      hooks: { Stop: [] },
    }), 'utf8');

    const patch = makeClaudeCodePatch(configPath);
    applyConfigPatch(patch, PEER_ID, 9456);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(config['model'], 'antseed');
    assert.deepEqual(config['hooks'], { Stop: [] });
    assert.deepEqual(config['env'], {
      DISABLE_AUTO_COMPACT: '1',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: 'http://localhost:9456',
      ANTHROPIC_AUTH_TOKEN: 'antseed',
      ANTHROPIC_CUSTOM_HEADERS: 'x-antseed-system-proxy-source: claude-code',
    });
    assert.ok(existsSync(`${configPath}.antseed.bak`));
    assert.ok(existsSync(`${configPath}.antseed.state.json`));

    applyConfigPatch(patch, PEER_ID, 8377);
    assert.equal(removeConfigPatch(patch), true);
    const restored = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(restored, {
      model: 'sonnet',
      env: {
        DISABLE_AUTO_COMPACT: '1',
        ANTHROPIC_API_KEY: 'user-key',
      },
      hooks: { Stop: [] },
    });
    assert.equal(existsSync(`${configPath}.antseed.state.json`), false);
    assert.equal(removeConfigPatch(patch), false);
  });
});

test('Claude Code patch removal keeps user edits to managed keys', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const patch = makeClaudeCodePatch(configPath);
    applyConfigPatch(patch, PEER_ID, 8377);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    config['model'] = 'opus';
    config['env']['ANTHROPIC_BASE_URL'] = 'https://gateway.example.test';
    await writeFile(configPath, JSON.stringify(config), 'utf8');

    assert.equal(removeConfigPatch(patch), true);
    const cleaned = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(cleaned['model'], 'opus');
    assert.deepEqual(cleaned['env'], { ANTHROPIC_BASE_URL: 'https://gateway.example.test' });
  });
});

test('Claude Code patch removes a settings file it created', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const patch = makeClaudeCodePatch(configPath);
    applyConfigPatch(patch, PEER_ID, 8377);
    assert.equal(removeConfigPatch(patch), true);
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(`${configPath}.antseed.state.json`), false);
  });
});

// --- T3 Code ---

test('T3 Code patch adds Antseed Claude provider and preserves existing settings', async () => {
  await withTempConfig(async (_dir, configPath) => {
    await writeFile(configPath, JSON.stringify({
      theme: 'dark',
      providerInstances: {
        codex: { driver: 'codex', displayName: 'Codex' },
      },
    }), 'utf8');

    applyConfigPatch(makeT3CodePatch(configPath), PEER_ID, 9456);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(config['theme'], 'dark');
    const providers = config['providerInstances'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(providers['codex'], { driver: 'codex', displayName: 'Codex' });
    assert.deepEqual(providers['antseed'], {
      driver: 'claudeAgent',
      displayName: 'Antseed',
      environment: [
        { name: 'ANTHROPIC_BASE_URL', value: 'http://localhost:9456', sensitive: false },
        { name: 'ANTHROPIC_API_KEY', value: 'antseed', sensitive: false },
        { name: 'ANTHROPIC_CUSTOM_HEADERS', value: 'x-antseed-system-proxy-source: t3code', sensitive: false },
        { name: 'HTTP_PROXY', value: '', sensitive: false },
        { name: 'HTTPS_PROXY', value: '', sensitive: false },
        { name: 'http_proxy', value: '', sensitive: false },
        { name: 'https_proxy', value: '', sensitive: false },
        { name: 'NO_PROXY', value: 'localhost,127.0.0.1,::1', sensitive: false },
        { name: 'no_proxy', value: 'localhost,127.0.0.1,::1', sensitive: false },
        { name: 'NODE_OPTIONS', value: '', sensitive: false },
      ],
      enabled: true,
      config: {
        customModels: ['antseed'],
      },
    });
  });
});

test('T3 Code patch removal only removes the managed Antseed provider', async () => {
  await withTempConfig(async (_dir, configPath) => {
    const patch = makeT3CodePatch(configPath);
    applyConfigPatch(patch, PEER_ID, 8377);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    (config['providerInstances'] as Record<string, unknown>)['codex'] = { driver: 'codex' };
    await writeFile(configPath, JSON.stringify(config), 'utf8');

    assert.equal(removeConfigPatch(patch), true);
    const cleaned = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(cleaned['providerInstances'], { codex: { driver: 'codex' } });
    assert.equal(removeConfigPatch(patch), false);
  });
});

// --- Zed ---

function makeZedPatch(configPath: string): ConfigPatchDef {
  return {
    format: 'zed',
    configPath,
    providerKey: 'antseed',
    providerName: 'Antseed',
    baseURL: 'http://127.0.0.1:{buyerPort}/v1',
  };
}

test('applyConfigPatch (zed) writes the openai_compatible provider and agent default model', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    await writeFile(configPath, '{\n  // zed user settings\n  "theme": "One Dark",\n}\n', 'utf8');

    applyConfigPatch(makeZedPatch(configPath), PEER_ID, 8377);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(config['theme'], 'One Dark');
    const provider = config['language_models']['openai_compatible']['Antseed'];
    assert.equal(provider['api_url'], 'http://127.0.0.1:8377/v1');
    assert.equal(provider['available_models'][0]['name'], 'antseed');
    assert.ok(provider['available_models'].every((model: Record<string, unknown>) => model['max_tokens'] === ANTSEED_MODEL_CONTEXT_WINDOW));
    assert.deepEqual(config['agent']['default_model'], { provider: 'Antseed', model: 'antseed' });
    assert.ok(existsSync(`${configPath}.antseed.bak`));
  });
});

test('removeConfigPatch (zed) removes the managed provider and matching default model only', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    await writeFile(configPath, JSON.stringify({
      theme: 'One Dark',
      language_models: {
        openai_compatible: {
          Antseed: { api_url: 'http://127.0.0.1:8377/v1', available_models: [] },
          Groq: { api_url: 'https://api.groq.com/openai/v1', available_models: [] },
        },
      },
      agent: { default_model: { provider: 'Antseed', model: 'antseed' }, always_allow_tool_actions: true },
    }), 'utf8');

    assert.equal(removeConfigPatch(makeZedPatch(configPath)), true);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(config['theme'], 'One Dark');
    assert.deepEqual(Object.keys(config['language_models']['openai_compatible']), ['Groq']);
    assert.equal(config['agent']['default_model'], undefined);
    assert.equal(config['agent']['always_allow_tool_actions'], true);
  });
});

test('applyConfigPatch (hermes) adds Antseed provider and selects it', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    await writeFile(configPath, 'display:\n  skin: cyberpunk\n', 'utf8');
    const patch: ConfigPatchDef = {
      format: 'hermes',
      configPath,
      providerKey: 'antseed',
      baseURL: 'http://localhost:{buyerPort}/v1',
    };

    applyConfigPatch(patch, PEER_ID, 8377);

    const config = parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(config['display']['skin'], 'cyberpunk');
    assert.equal(config['providers']['antseed']['api'], 'http://localhost:8377/v1');
    assert.equal(config['providers']['antseed']['transport'], 'chat_completions');
    assert.deepEqual(config['providers']['antseed']['extra_headers'], { originator: 'hermes' });
    assert.equal(config['providers']['antseed']['default_model'], 'antseed');
    assert.equal(config['providers']['antseed']['models']['antseed']['context_length'], ANTSEED_MODEL_CONTEXT_WINDOW);
    assert.deepEqual(config['model'], {
      provider: 'antseed',
      default: 'antseed',
      base_url: '',
      api_mode: 'chat_completions',
    });
    assert.ok(existsSync(`${configPath}.antseed.bak`));
  });
});

test('removeConfigPatch (hermes) removes only the managed provider and selection', async () => {
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.yaml');
    const patch: ConfigPatchDef = {
      format: 'hermes',
      configPath,
      providerKey: 'antseed',
      baseURL: 'http://localhost:{buyerPort}/v1',
    };
    applyConfigPatch(patch, PEER_ID, 8377);

    assert.equal(removeConfigPatch(patch), true);

    const config = parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    assert.equal(config['providers']?.['antseed'], undefined);
    assert.equal(config['model']?.['provider'], undefined);
    assert.equal(config['model']?.['default'], undefined);
  });
});

// Every built-in profile must parse through readConfigPatch and keep its own
// format. A format missing its branch falls through to opencode, whose `npm`
// requirement throws while profiles load — which crashes the app at startup
// (0.1.115-alpha-0.14 shipped that crash for t3code).
test('readConfigPatch parses every default app profile under its declared format', () => {
  for (const profile of DEFAULT_APP_PROFILES) {
    const raw = profile as Record<string, unknown>;
    const name = raw['name'] as string;
    const rawPatch = raw['configPatch'] as Record<string, unknown>;
    const parsed = readConfigPatch(rawPatch, name);
    assert.ok(parsed, `default profile ${name} must define a configPatch`);
    assert.equal(parsed.format, rawPatch['format'] ?? 'opencode', `profile ${name} fell through to another format`);
  }
});

test('substituteBaseUrlHost swaps only the host', () => {
  assert.equal(
    substituteBaseUrlHost('http://localhost:{buyerPort}/v1', '172.29.32.1'),
    'http://172.29.32.1:{buyerPort}/v1',
  );
  assert.equal(
    substituteBaseUrlHost('http://localhost:9411/v1', 'localhost'),
    'http://localhost:9411/v1',
  );
});

test('applyConfigPatch with installProbe patches an existing native config dir', { skip: process.platform === 'win32' }, async () => {
  // Skipped on Windows: there the probe would invoke real WSL discovery.
  await withTempConfig(async (_dir, configPath) => {
    const patch: ConfigPatchDef = { ...(makePatch(configPath) as OpencodeConfigPatchDef), installProbe: 'opencode' };
    applyConfigPatch(patch, PEER_ID, 9456);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      provider: Record<string, { options: { baseURL: string } }>;
    };
    assert.equal(config.provider['antseed']!.options.baseURL, 'http://127.0.0.1:9456/v1');
  });
});

test('removeConfigPatch with a WSL targets file unpatches the recorded targets and clears the file', async () => {
  await withTempConfig(async (dir, configPath) => {
    const wslConfigPath = path.join(dir, 'wsl-opencode.jsonc');
    const wslTargetsFile = path.join(dir, 'system-proxy.wsl-targets.json');
    const patch: ConfigPatchDef = { ...(makePatch(configPath) as OpencodeConfigPatchDef), installProbe: 'opencode' };

    applyConfigPatch(patch, PEER_ID, 9456);
    // Simulate a target the Windows-side apply would have recorded, pointing
    // at a config file this test can inspect in place of a real UNC path.
    applyConfigPatch(makePatch(wslConfigPath), PEER_ID, 9456);
    await writeFile(wslTargetsFile, JSON.stringify([
      { tool: 'opencode', distro: 'Ubuntu', configPath: wslConfigPath, host: '172.29.32.1', needsRelay: true },
    ]), 'utf8');

    assert.equal(removeConfigPatch(patch, wslTargetsFile), true);

    const wslConfig = JSON.parse(await readFile(wslConfigPath, 'utf8')) as { provider?: Record<string, unknown> };
    assert.equal(wslConfig.provider?.['antseed'], undefined);
    assert.equal(existsSync(wslTargetsFile), false);
  });
});

test('applyConfigPatch (codex) with installProbe patches an existing native config dir', { skip: process.platform === 'win32' }, async () => {
  // Skipped on Windows: there the probe would invoke real WSL discovery.
  await withTempConfig(async (dir) => {
    const configPath = path.join(dir, 'config.toml');
    const patch: ConfigPatchDef = { ...(makeCodexPatch(configPath) as CodexConfigPatchDef), installProbe: 'codex' };
    applyConfigPatch(patch, PEER_ID, 9456);
    const raw = await readFile(configPath, 'utf8');
    assert.ok(raw.includes('base_url = "http://127.0.0.1:9456/v1"'));
    assert.ok(raw.includes('model_provider = "antseed"'));
  });
});

test('removeConfigPatch (goose) unpatches WSL configs carrying the gateway host', async () => {
  await withTempConfig(async (dir) => {
    const nativePath = path.join(dir, 'native-config.yaml');
    const wslPath = path.join(dir, 'wsl-config.yaml');
    const wslTargetsFile = path.join(dir, 'targets.json');
    // Simulate the WSL-side config the Windows apply would have written: the
    // base URL carries the NAT gateway host, not a loopback address.
    applyConfigPatch(
      { format: 'goose', configPath: wslPath, providerKey: 'openai', baseURL: 'http://172.29.32.1:{buyerPort}' },
      PEER_ID,
      9456,
    );
    await writeFile(wslTargetsFile, JSON.stringify([
      { tool: 'goose', distro: 'Ubuntu', configPath: wslPath, host: '172.29.32.1', needsRelay: true },
    ]), 'utf8');

    const patch: ConfigPatchDef = {
      format: 'goose',
      configPath: nativePath,
      providerKey: 'openai',
      baseURL: 'http://localhost:{buyerPort}',
      installProbe: 'goose',
    };
    assert.equal(removeConfigPatch(patch, wslTargetsFile), true);

    const raw = await readFile(wslPath, 'utf8');
    assert.ok(!raw.includes('OPENAI_HOST'));
    assert.ok(!raw.includes('GOOSE_PROVIDER'));
    assert.equal(existsSync(wslTargetsFile), false);
  });
});

// ---------------------------------------------------------------------------
// Claude Desktop third-party inference patch
// ---------------------------------------------------------------------------

function makeClaudeDesktopPatch(dir: string): ClaudeDesktopConfigPatchDef {
  return {
    format: 'claude-desktop',
    configPath: path.join(dir, 'Claude', 'claude_desktop_config.json'),
    thirdPartyDir: path.join(dir, 'Claude-3p'),
    baseURL: 'http://127.0.0.1:{claudeGatewayPort}',
  };
}

test('applyConfigPatch writes the Claude third-party profile and flips both deployment modes', async () => {
  await withTempConfig(async (dir) => {
    const patch = makeClaudeDesktopPatch(dir);
    await mkdir(path.dirname(patch.configPath), { recursive: true });
    await writeFile(patch.configPath, JSON.stringify({ mcpServers: { fs: { command: 'fs-server' } } }), 'utf8');

    applyConfigPatch(patch, PEER_ID, 9456);

    const normal = parseJsoncObject(await readFile(patch.configPath, 'utf8'), patch.configPath);
    assert.equal(normal['deploymentMode'], '3p');
    // Untouched beyond the mode flip — Claude's own settings must survive.
    assert.deepEqual(normal['mcpServers'], { fs: { command: 'fs-server' } });
    assert.ok(existsSync(`${patch.configPath}.antseed.bak`));

    const thirdParty = parseJsoncObject(
      await readFile(path.join(patch.thirdPartyDir, 'claude_desktop_config.json'), 'utf8'), 'claude_desktop_config.json');
    assert.equal(thirdParty['deploymentMode'], '3p');

    const profilePath = path.join(patch.thirdPartyDir, 'configLibrary', `${CLAUDE_DESKTOP_PROFILE_ID}.json`);
    const profile = parseJsoncObject(await readFile(profilePath, 'utf8'), profilePath);
    assert.equal(profile['inferenceProvider'], 'gateway');
    assert.equal(profile['inferenceGatewayBaseUrl'], `http://127.0.0.1:${CLAUDE_GATEWAY_DEFAULT_PORT}`);
    assert.equal(profile['inferenceGatewayAuthScheme'], 'bearer');
    assert.equal(profile['deploymentDisplayName'], 'Antseed');
    assert.equal(profile['disableDeploymentModeChooser'], true);
    assert.deepEqual(profile['coworkEgressAllowedHosts'], ['*']);
    // The published model catalog would relabel gateway slots by Claude id.
    assert.equal(profile['modelCatalogEnabled'], false);

    const metaPath = path.join(patch.thirdPartyDir, 'configLibrary', '_meta.json');
    const meta = parseJsoncObject(await readFile(metaPath, 'utf8'), metaPath);
    assert.equal(meta['appliedId'], CLAUDE_DESKTOP_PROFILE_ID);
    assert.deepEqual(meta['entries'], [{ id: CLAUDE_DESKTOP_PROFILE_ID, name: 'Antseed' }]);

    // Re-apply is idempotent: no duplicate configLibrary entries.
    applyConfigPatch(patch, PEER_ID, 9456);
    const metaAgain = parseJsoncObject(await readFile(metaPath, 'utf8'), metaPath);
    assert.deepEqual(metaAgain['entries'], [{ id: CLAUDE_DESKTOP_PROFILE_ID, name: 'Antseed' }]);
  });
});

test('applyConfigPatch refuses to configure Claude Desktop when it is not installed', async () => {
  await withTempConfig(async (dir) => {
    const patch = makeClaudeDesktopPatch(dir);
    assert.throws(() => applyConfigPatch(patch, PEER_ID, 9456), /Claude Desktop was not found/);
    assert.equal(existsSync(patch.thirdPartyDir), false);
  });
});

test('removeConfigPatch restores the Claude profile it wrote', async () => {
  await withTempConfig(async (dir) => {
    const patch = makeClaudeDesktopPatch(dir);
    await mkdir(path.dirname(patch.configPath), { recursive: true });
    applyConfigPatch(patch, PEER_ID, 9456);

    assert.equal(removeConfigPatch(patch), true);

    const normal = parseJsoncObject(await readFile(patch.configPath, 'utf8'), patch.configPath);
    assert.equal(normal['deploymentMode'], '1p');
    const thirdParty = parseJsoncObject(
      await readFile(path.join(patch.thirdPartyDir, 'claude_desktop_config.json'), 'utf8'), 'claude_desktop_config.json');
    assert.equal(thirdParty['deploymentMode'], '1p');

    const metaPath = path.join(patch.thirdPartyDir, 'configLibrary', '_meta.json');
    const meta = parseJsoncObject(await readFile(metaPath, 'utf8'), metaPath);
    assert.equal(meta['appliedId'], undefined);
    assert.deepEqual(meta['entries'], []);

    const profilePath = path.join(patch.thirdPartyDir, 'configLibrary', `${CLAUDE_DESKTOP_PROFILE_ID}.json`);
    const profile = parseJsoncObject(await readFile(profilePath, 'utf8'), profilePath);
    assert.equal(profile['inferenceProvider'], undefined);
    assert.equal(profile['inferenceGatewayBaseUrl'], undefined);
    assert.equal(profile['disableDeploymentModeChooser'], false);

    // Nothing left to unwind on a second remove.
    assert.equal(removeConfigPatch(patch), false);
  });
});

test('removeConfigPatch leaves a third-party setup it did not create alone', async () => {
  await withTempConfig(async (dir) => {
    const patch = makeClaudeDesktopPatch(dir);
    await mkdir(path.dirname(patch.configPath), { recursive: true });
    await writeFile(patch.configPath, JSON.stringify({ deploymentMode: '3p' }), 'utf8');
    const configLibrary = path.join(patch.thirdPartyDir, 'configLibrary');
    await mkdir(configLibrary, { recursive: true });
    // An enterprise/MDM-provisioned gateway profile: different id, remote host.
    await writeFile(path.join(configLibrary, '_meta.json'), JSON.stringify({
      appliedId: 'corp-profile',
      entries: [{ id: 'corp-profile', name: 'Corp Gateway' }],
    }), 'utf8');

    assert.equal(removeConfigPatch(patch), false);

    const normal = parseJsoncObject(await readFile(patch.configPath, 'utf8'), patch.configPath);
    assert.equal(normal['deploymentMode'], '3p');
    const meta = parseJsoncObject(await readFile(path.join(configLibrary, '_meta.json'), 'utf8'), '_meta.json');
    assert.equal(meta['appliedId'], 'corp-profile');
  });
});

test('claudeDesktopPatchTargets: posix uses the profile paths as the single target', () => {
  const patch = makeClaudeDesktopPatch('/base');
  const targets = claudeDesktopPatchTargets(patch, 'darwin', {});
  assert.deepEqual(targets, [{
    configPath: path.join('/base', 'Claude', 'claude_desktop_config.json'),
    thirdPartyDir: path.join('/base', 'Claude-3p'),
  }]);
});

test('claudeDesktopPatchTargets: windows probes classic, MSIX, local, and Nest roots in order', () => {
  const patch = makeClaudeDesktopPatch('/ignored');
  const env = { APPDATA: '/win/Roaming', LOCALAPPDATA: '/win/Local' };
  const listDir = (dir: string) => (
    dir === path.join('/win/Local', 'Packages')
      ? ['Claude_pzs8sxrjxfjjc', 'SomeOtherApp_abc', 'Claude_dev123']
      : []
  );
  const targets = claudeDesktopPatchTargets(patch, 'win32', env, listDir);
  assert.deepEqual(targets.map((target) => target.configPath), [
    path.join('/win/Roaming', 'Claude', 'claude_desktop_config.json'),
    path.join('/win/Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    path.join('/win/Local', 'Packages', 'Claude_dev123', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    path.join('/win/Local', 'Claude', 'claude_desktop_config.json'),
    path.join('/win/Roaming', 'Claude Nest', 'claude_desktop_config.json'),
    path.join('/win/Local', 'Claude Nest', 'claude_desktop_config.json'),
  ]);
  // The 3p profile directory is always the sibling `<root>-3p`.
  assert.equal(targets[0]!.thirdPartyDir, path.join('/win/Roaming', 'Claude-3p'));
  assert.equal(
    targets[1]!.thirdPartyDir,
    path.join('/win/Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude-3p'),
  );
});

test('claudeDesktopPatchTargets: a missing Packages directory just skips the MSIX candidates', () => {
  const patch = makeClaudeDesktopPatch('/ignored');
  const targets = claudeDesktopPatchTargets(patch, 'win32', { APPDATA: '/r', LOCALAPPDATA: '/l' }, () => []);
  assert.equal(targets.length, 4);
  assert.equal(targets[0]!.configPath, path.join('/r', 'Claude', 'claude_desktop_config.json'));
});
