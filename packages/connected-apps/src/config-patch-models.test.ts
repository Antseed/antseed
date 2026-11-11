/**
 * Which models each writer lists and selects across refreshes: a model the
 * user picked inside the app survives while the gateway serves it (even
 * unlisted, or under another of its ids), and a gateway that serves no text
 * models empties the list where one that could not be read keeps it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse, parseDocument } from 'yaml';

import { finishConfigPatch, removeConfigPatch, writeConfigPatch, type ConfigPatchDef, type ConfigPatchModel, type ConfigPatchTarget } from './config-patch.js';

const KEY = 'antseed_test_0123456789';
const A = { id: 'model-a', label: 'Model A' };
const B = { id: 'model-b', label: 'Model B' };
const C = { id: 'model-c', label: 'Model C' };

const target = (models: ConfigPatchModel[], extra: Partial<ConfigPatchTarget> = {}): ConfigPatchTarget => ({
  origin: 'http://localhost:8379', apiKey: KEY, models, modelsLoaded: true, defaultModel: models[0]?.id, ...extra,
});

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-model-pick-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const readJson = async (file: string): Promise<Record<string, any>> => JSON.parse(await readFile(file, 'utf8'));
const readYaml = async (file: string): Promise<Record<string, any>> => (parse(await readFile(file, 'utf8')) ?? {}) as Record<string, any>;

/** One writer: its patch, and how to read (and, as the user would in the app, change) its list and selection. */
type Writer = {
  name: string;
  patch: (dir: string) => ConfigPatchDef;
  /** The model ids the config lists; null for a tool that keeps no list. */
  listed: (dir: string) => Promise<string[] | null>;
  /** Every selection the config holds (Crush has two). */
  selected: (dir: string) => Promise<unknown[]>;
  select: (dir: string, id: string) => Promise<void>;
};

async function editJson(file: string, edit: (config: Record<string, any>) => void): Promise<void> {
  const config = await readJson(file);
  edit(config);
  await writeFile(file, JSON.stringify(config), 'utf8');
}

const WRITERS: Writer[] = [
  {
    name: 'OpenCode',
    patch: (dir) => ({ configPath: path.join(dir, 'opencode.json'), providerKey: 'antseed', npm: '@ai-sdk/openai-compatible', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' }),
    listed: async (dir) => Object.keys((await readJson(path.join(dir, 'opencode.json')))['provider']['antseed']['models']),
    selected: async (dir) => [(await readJson(path.join(dir, 'opencode.json')))['model']?.replace(/^antseed\//, '')],
    select: (dir, id) => editJson(path.join(dir, 'opencode.json'), (config) => { config['model'] = `antseed/${id}`; }),
  },
  {
    name: 'Droid',
    patch: (dir) => ({ format: 'droid', configPath: path.join(dir, 'droid.json'), providerKey: 'antseed', providerName: 'Antseed Auto', baseURL: 'http://localhost:{buyerPort}/v1', originator: 'droid' }),
    listed: async (dir) => ((await readJson(path.join(dir, 'droid.json')))['customModels'] ?? []).map((entry: { model: string }) => entry.model),
    selected: async (dir) => {
      const config = await readJson(path.join(dir, 'droid.json'));
      const id = config['sessionDefaultSettings']?.['model'];
      return [(config['customModels'] ?? []).find((entry: { id: string }) => entry.id === id)?.model ?? id];
    },
    select: (dir, id) => editJson(path.join(dir, 'droid.json'), (config) => {
      // Droid selects an entry; the one for this model, however its id is written.
      config['sessionDefaultSettings']['model'] = config['customModels'].find((entry: { model: string }) => entry.model.toLowerCase() === id.toLowerCase()).id;
    }),
  },
  {
    name: 'pi',
    patch: (dir) => ({ format: 'pi', configPath: path.join(dir, 'models.json'), settingsPath: path.join(dir, 'settings.json'), providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}/v1', api: 'openai-completions' }),
    listed: async (dir) => (await readJson(path.join(dir, 'models.json')))['providers']['antseed']['models'].map((model: { id: string }) => model.id),
    selected: async (dir) => [(await readJson(path.join(dir, 'settings.json')))['defaultModel']],
    select: (dir, id) => editJson(path.join(dir, 'settings.json'), (settings) => { settings['defaultModel'] = id; }),
  },
  {
    name: 'Crush',
    patch: (dir) => ({ format: 'crush', configPath: path.join(dir, 'crush.json'), providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' }),
    listed: async (dir) => (await readJson(path.join(dir, 'crush.json')))['providers']['antseed']['models'].map((model: { id: string }) => model.id),
    selected: async (dir) => {
      const models = (await readJson(path.join(dir, 'crush.json')))['models'];
      return [models['large']['model'], models['small']['model']];
    },
    select: (dir, id) => editJson(path.join(dir, 'crush.json'), (config) => {
      config['models']['large']['model'] = id;
      config['models']['small']['model'] = id;
    }),
  },
  {
    name: 'goose',
    patch: (dir) => ({ format: 'goose', configPath: path.join(dir, 'config.yaml'), providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' }),
    listed: async (dir) => (await readJson(path.join(dir, 'custom_providers', 'custom_antseed.json')))['models'].map((model: { name: string }) => model.name),
    selected: async (dir) => [(await readYaml(path.join(dir, 'config.yaml')))['GOOSE_MODEL']],
    select: async (dir, id) => {
      const file = path.join(dir, 'config.yaml');
      await writeFile(file, (await readFile(file, 'utf8')).replace(/^GOOSE_MODEL:.*$/m, `GOOSE_MODEL: "${id}"`), 'utf8');
    },
  },
  {
    name: 'Hermes',
    patch: (dir) => ({ format: 'hermes', configPath: path.join(dir, 'hermes.yaml'), providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}/v1' }),
    listed: async (dir) => Object.keys((await readYaml(path.join(dir, 'hermes.yaml')))['providers']['antseed']['models']),
    selected: async (dir) => {
      const config = await readYaml(path.join(dir, 'hermes.yaml'));
      return [config['model']['default'], config['providers']['antseed']['default_model']];
    },
    select: async (dir, id) => {
      const file = path.join(dir, 'hermes.yaml');
      const document = parseDocument(await readFile(file, 'utf8'));
      document.setIn(['model', 'default'], id);
      await writeFile(file, document.toString(), 'utf8');
    },
  },
  {
    name: 'Zed',
    patch: (dir) => ({ format: 'zed', configPath: path.join(dir, 'zed.json'), providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' }),
    listed: async (dir) => (await readJson(path.join(dir, 'zed.json')))['language_models']['openai_compatible']['Antseed']['available_models'].map((model: { name: string }) => model.name),
    selected: async (dir) => [(await readJson(path.join(dir, 'zed.json')))['agent']['default_model']['model']],
    select: (dir, id) => editJson(path.join(dir, 'zed.json'), (config) => { config['agent']['default_model']['model'] = id; }),
  },
  {
    name: 'Claude Code',
    patch: (dir) => ({ format: 'claude-code', configPath: path.join(dir, 'claude.json'), providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}' }),
    listed: async () => null,
    selected: async (dir) => [(await readJson(path.join(dir, 'claude.json')))['model']],
    select: (dir, id) => editJson(path.join(dir, 'claude.json'), (config) => { config['model'] = id; }),
  },
  {
    name: 'Codex',
    patch: (dir) => ({ format: 'codex', configPath: path.join(dir, 'config.toml'), providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' }),
    listed: async () => null,
    selected: async (dir) => [/^model = "(.*)"$/m.exec(await readFile(path.join(dir, 'config.toml'), 'utf8'))?.[1]],
    select: async (dir, id) => {
      const file = path.join(dir, 'config.toml');
      await writeFile(file, (await readFile(file, 'utf8')).replace(/^model = ".*"$/m, `model = "${id}"`), 'utf8');
    },
  },
];

for (const writer of WRITERS) {
  test(`${writer.name}: a model the user picked stays while the gateway serves it unlisted, and goes once it doesn't`, async () => {
    await withDir(async (dir) => {
      const patch = writer.patch(dir);
      writeConfigPatch(patch, target([A, B, C]));
      await writer.select(dir, C.id);
      // A privacy switch: only low-trust sellers serve C now, so the list leaves it out.
      writeConfigPatch(patch, target([A, B], { unlistedModels: [C] }));
      for (const selected of await writer.selected(dir)) assert.equal(selected, C.id);
      const listed = await writer.listed(dir);
      if (listed) assert.deepEqual(listed, [A.id, B.id, C.id]);
      // A refresh with C still unlisted lists it once.
      writeConfigPatch(patch, target([A, B], { unlistedModels: [C] }));
      if (listed) assert.deepEqual(await writer.listed(dir), [A.id, B.id, C.id]);
      // Gone from the gateway: replaced by the default, and no longer listed.
      writeConfigPatch(patch, target([A, B], { defaultModel: B.id }));
      for (const selected of await writer.selected(dir)) assert.equal(selected, B.id);
      if (listed) assert.deepEqual(await writer.listed(dir), [A.id, B.id]);
      // A model the target doesn't serve at all is never added.
      await writer.select(dir, A.id);
      writeConfigPatch(patch, target([A, B], { unlistedModels: [C] }));
      if (listed) assert.deepEqual(await writer.listed(dir), [A.id, B.id]);
      removeConfigPatch(patch);
    });
  });

  test(`${writer.name}: a model the gateway now lists under another of its ids stays selected`, async () => {
    await withDir(async (dir) => {
      const patch = writer.patch(dir);
      // The same model by the buyer's canonical rule, listed by a different id each read.
      const short = { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash' };
      const long = { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash' };
      const titled = { id: 'GLM-5.3-Flash', label: 'GLM 5.3 Flash' };
      writeConfigPatch(patch, target([A, short]));
      await writer.select(dir, short.id);
      writeConfigPatch(patch, target([A, long]));
      for (const selected of await writer.selected(dir)) assert.equal(selected, long.id);
      writeConfigPatch(patch, target([A, titled]));
      for (const selected of await writer.selected(dir)) assert.equal(selected, titled.id);
      writeConfigPatch(patch, target([A, short]));
      for (const selected of await writer.selected(dir)) assert.equal(selected, short.id);
      removeConfigPatch(patch);
    });
  });

  test(`${writer.name}: an exact id beats a canonical match, and a dated variant is another model`, async () => {
    await withDir(async (dir) => {
      const patch = writer.patch(dir);
      const short = { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash' };
      const long = { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash' };
      writeConfigPatch(patch, target([A, short]));
      await writer.select(dir, short.id);
      // Both ids listed: the selection stays on the one it names.
      writeConfigPatch(patch, target([A, long, short]));
      for (const selected of await writer.selected(dir)) assert.equal(selected, short.id);
      // `deepseek-v4-1-flash-1017` is not `deepseek-v4.1-flash`: the selection falls back to the default.
      const dated = { id: 'deepseek-v4-1-flash-1017', label: 'DeepSeek V4.1 Flash 1017' };
      const plain = { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' };
      writeConfigPatch(patch, target([A, dated]));
      await writer.select(dir, dated.id);
      writeConfigPatch(patch, target([A, plain]));
      for (const selected of await writer.selected(dir)) assert.equal(selected, A.id);
      removeConfigPatch(patch);
    });
  });
}

const LISTING_WRITERS = WRITERS.filter((writer) => !['Claude Code', 'Codex'].includes(writer.name));

for (const writer of LISTING_WRITERS) {
  test(`${writer.name}: a gateway serving no text models empties the list; one that could not be read keeps it`, async () => {
    await withDir(async (dir) => {
      const patch = writer.patch(dir);
      writeConfigPatch(patch, target([A, B]));
      writeConfigPatch(patch, { ...target([]), modelsLoaded: false });
      assert.deepEqual(await writer.listed(dir), [A.id, B.id]);
      // Without the flag, an empty list still reads as one that didn't load.
      writeConfigPatch(patch, { origin: 'http://localhost:8379', apiKey: KEY, models: [] });
      assert.deepEqual(await writer.listed(dir), [A.id, B.id]);
      writeConfigPatch(patch, target([]));
      assert.deepEqual(await writer.listed(dir), []);
      // The models come back.
      writeConfigPatch(patch, target([A]));
      assert.deepEqual(await writer.listed(dir), [A.id]);
      removeConfigPatch(patch);
    });
  });
}

test('T3 Code: a gateway serving no text models empties the list; one that could not be read keeps it', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'settings.json');
    const patch: ConfigPatchDef = { format: 't3code', configPath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}' };
    const listed = async () => (await readJson(configPath))['providerInstances']['antseed']['config']['customModels'];
    writeConfigPatch(patch, target([A, B]));
    writeConfigPatch(patch, { ...target([]), modelsLoaded: false });
    assert.deepEqual(await listed(), [A.id, B.id]);
    writeConfigPatch(patch, target([]));
    assert.deepEqual(await listed(), []);
  });
});

test('Hermes and goose: a gateway serving no text models keeps discovery off in Hermes, and leaves goose without dynamic_models', async () => {
  await withDir(async (dir) => {
    const hermesPath = path.join(dir, 'hermes.yaml');
    const hermes: ConfigPatchDef = { format: 'hermes', configPath: hermesPath, providerKey: 'antseed', baseURL: 'http://localhost:{buyerPort}/v1' };
    writeConfigPatch(hermes, target([A]));
    writeConfigPatch(hermes, target([]));
    const provider = (await readYaml(hermesPath))['providers']['antseed'];
    // Discovery would list the gateway's image and video models as chat models.
    assert.equal(provider['discover_models'], false);
    assert.equal(provider['default_model'], undefined);

    const goosePath = path.join(dir, 'goose', 'config.yaml');
    const goose: ConfigPatchDef = { format: 'goose', configPath: goosePath, providerKey: 'openai', baseURL: 'http://localhost:{buyerPort}' };
    writeConfigPatch(goose, target([A]));
    writeConfigPatch(goose, target([]));
    const custom = await readJson(path.join(dir, 'goose', 'custom_providers', 'custom_antseed.json'));
    assert.deepEqual(custom['models'], []);
    // Goose refuses dynamic_models: false without models.
    assert.equal('dynamic_models' in custom, false);
  });
});

test('Droid: a gateway serving no text models removes our entries and gives the user their own default back', async () => {
  await withDir(async (dir) => {
    const configPath = path.join(dir, 'droid.json');
    const patch: ConfigPatchDef = { format: 'droid', configPath, providerKey: 'antseed', providerName: 'Antseed Auto', baseURL: 'http://localhost:{buyerPort}/v1', originator: 'droid' };
    const mine = { model: 'mine', id: 'custom:mine', baseUrl: 'https://mine.example' };
    const original = { customModels: [mine], sessionDefaultSettings: { model: 'custom:mine', reasoningEffort: 'high' } };
    await writeFile(configPath, JSON.stringify(original), 'utf8');
    writeConfigPatch(patch, target([A, B]));
    writeConfigPatch(patch, target([]));
    assert.deepEqual(await readJson(configPath), original);
    // The models come back, and disconnect still restores the original.
    writeConfigPatch(patch, target([A]));
    assert.equal((await readJson(configPath))['customModels'].length, 2);
    assert.equal(removeConfigPatch(patch), true);
    assert.deepEqual(await readJson(configPath), original);
  });
});

test('Codex: the catalog lists a model the user is on that the gateway serves unlisted, and goes with the text models', { skip: process.platform === 'win32' }, async () => {
  await withDir(async (dir) => {
    const bin = path.join(dir, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'codex'), `#!/bin/sh
if [ "$3" = "--bundled" ]; then echo '{"models":[{"base_instructions":"be good","truncation_policy":{"mode":"tokens","limit":1}}]}'; exit 0; fi
exit 0
`, { mode: 0o755 });
    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${bin}${path.delimiter}${originalPath}`;
    try {
      const configPath = path.join(dir, 'config.toml');
      const catalogPath = path.join(dir, 'antseed-models.json');
      const patch: ConfigPatchDef = { format: 'codex', configPath, providerKey: 'antseed', providerName: 'Antseed', baseURL: 'http://localhost:{buyerPort}/v1' };
      const apply = async (t: ConfigPatchTarget) => {
        writeConfigPatch(patch, t);
        await finishConfigPatch(patch, t);
      };
      await apply(target([A, B, C]));
      await writeFile(configPath, (await readFile(configPath, 'utf8')).replace(/^model = ".*"$/m, `model = "${C.id}"`), 'utf8');
      await apply(target([A, B], { unlistedModels: [C] }));
      const slugs = async () => (await readJson(catalogPath))['models'].map((model: { slug: string }) => model.slug);
      assert.deepEqual(await slugs(), [A.id, B.id, C.id]);

      // Unread: the catalog stays as it was.
      await apply({ ...target([]), modelsLoaded: false });
      assert.deepEqual(await slugs(), [A.id, B.id, C.id]);
      // No text models at all: no catalog naming models the gateway doesn't serve.
      await apply(target([]));
      assert.equal(existsSync(catalogPath), false);
      assert.ok(!(await readFile(configPath, 'utf8')).includes('model_catalog_json'));
      removeConfigPatch(patch);
    } finally {
      process.env['PATH'] = originalPath;
    }
  });
});
