import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCliChildEnv, ProcessManager, resolveCommandArgs } from './process-manager.js';

test('local desktop CLI runs may prepare trusted plugins', () => {
  const env = buildCliChildEnv({ ANTSEED_SKIP_PLUGIN_UPDATE_CHECK: '1' }, true);
  assert.equal(env['ANTSEED_SKIP_PLUGIN_UPDATE_CHECK'], undefined);
});

test('packaged desktop CLI runs remain offline-only', () => {
  const env = buildCliChildEnv({}, false);
  assert.equal(env['ANTSEED_SKIP_PLUGIN_UPDATE_CHECK'], '1');
});

test('live QA does not bypass native-module preflight', async () => {
  const previousDirectory = process.cwd();
  const previousQa = process.env['ANTSEED_LIVE_QA'];
  process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
  process.env['ANTSEED_LIVE_QA'] = '1';
  try {
    const manager = new ProcessManager(() => {}) as unknown as {
      ensureRuntimeNativeModules(mode: string, executable: string, isLocalDevScript: boolean): Promise<void>;
      runRuntimeNativeAlignment(): Promise<void>;
    };
    let alignments = 0;
    manager.runRuntimeNativeAlignment = async () => { alignments += 1; };
    await manager.ensureRuntimeNativeModules('connect', process.execPath, true);
    await manager.ensureRuntimeNativeModules('connect', process.execPath, true);
    assert.equal(alignments, 1);
  } finally {
    process.chdir(previousDirectory);
    if (previousQa === undefined) delete process.env['ANTSEED_LIVE_QA'];
    else process.env['ANTSEED_LIVE_QA'] = previousQa;
  }
});

test('resolveCommandArgs launches the grouped buyer runtime command without forcing the default router', () => {
  const args = resolveCommandArgs({
    mode: 'connect',
    router: 'local',
    configPath: '/tmp/antseed-config.json',
    verbose: true,
  });

  assert.deepEqual(args, [
    '--verbose',
    '--config', resolve('/tmp/antseed-config.json'),
    '--data-dir', join(homedir(), '.antseed'),
    'buyer', 'start',
  ]);
});

test('resolveCommandArgs forwards non-default routers', () => {
  const args = resolveCommandArgs({
    mode: 'connect',
    router: 'custom-router',
    configPath: '/tmp/antseed-config.json',
  });

  assert.deepEqual(args, [
    '--config', resolve('/tmp/antseed-config.json'),
    '--data-dir', join(homedir(), '.antseed'),
    'buyer', 'start', '--router', 'custom-router',
  ]);
});

test('resolveCommandArgs launches the System Proxy runtime with selected profiles and models', () => {
  const args = resolveCommandArgs({
    mode: 'system-proxy',
    configPath: '/tmp/antseed-config.json',
    systemProxyPeerId: '0123456789abcdef0123456789abcdef01234567',
    systemProxyPort: 8378,
    systemProxyProfiles: ['editor', 'browser'],
    systemProxyDefaultModel: 'model-a',
    systemProxyServedModels: ['model-a', 'model-b'],
    setSystemProxy: true,
  });

  assert.deepEqual(args, [
    '--config', resolve('/tmp/antseed-config.json'),
    '--data-dir', join(homedir(), '.antseed'),
    'system-proxy', 'start',
    '--peer', '0123456789abcdef0123456789abcdef01234567',
    '--port', '8378',
    '--profile', 'editor',
    '--profile', 'browser',
    '--default-model', 'model-a',
    '--served-model', 'model-a',
    '--served-model', 'model-b',
    '--system-proxy',
  ]);
});

test('resolveCommandArgs launches the public tunnel through the CLI', () => {
  const args = resolveCommandArgs({
    mode: 'tunnel',
    configPath: '/tmp/antseed-config.json',
    tunnelBuyerPort: 9456,
  });

  assert.deepEqual(args, [
    '--config', resolve('/tmp/antseed-config.json'),
    '--data-dir', join(homedir(), '.antseed'),
    'tunnel', 'start', '--buyer-port', '9456',
  ]);
});

test('attached runtimes can be stopped locally without owning the shared process', async () => {
  const logs: string[] = [];
  const processManager = new ProcessManager((_mode, _stream, line) => logs.push(line));

  const attached = processManager.attach('connect');
  assert.equal(attached.running, true);
  assert.equal(attached.pid, null);
  assert.equal(processManager.isAttached('connect'), true);

  const stopped = await processManager.stop('connect', true);
  assert.equal(stopped.running, false);
  assert.equal(stopped.pid, null);
  assert.equal(processManager.isAttached('connect'), false);
  assert.deepEqual(logs, ['Attached to existing connect runtime']);
});
