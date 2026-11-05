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
    await manager.ensureRuntimeNativeModules('gateway', process.execPath, true);
    await manager.ensureRuntimeNativeModules('gateway', process.execPath, true);
    assert.equal(alignments, 1);
  } finally {
    process.chdir(previousDirectory);
    if (previousQa === undefined) delete process.env['ANTSEED_LIVE_QA'];
    else process.env['ANTSEED_LIVE_QA'] = previousQa;
  }
});

test('resolveCommandArgs starts the local gateway on its port', () => {
  const args = resolveCommandArgs({
    mode: 'gateway',
    configPath: '/tmp/antseed-config.json',
    verbose: true,
    gatewayPort: 9456,
  });

  assert.deepEqual(args, [
    '--verbose',
    '--config', resolve('/tmp/antseed-config.json'),
    '--data-dir', join(homedir(), '.antseed'),
    'gateway', 'start', '--port', '9456',
  ]);
});

test('attached runtimes can be stopped locally without owning the shared process', async () => {
  const logs: string[] = [];
  const processManager = new ProcessManager((_mode, _stream, line) => logs.push(line));

  const attached = processManager.attach('gateway');
  assert.equal(attached.running, true);
  assert.equal(attached.pid, null);
  assert.equal(processManager.isAttached('gateway'), true);

  const stopped = await processManager.stop('gateway', true);
  assert.equal(stopped.running, false);
  assert.equal(stopped.pid, null);
  assert.equal(processManager.isAttached('gateway'), false);
  assert.deepEqual(logs, ['Attached to existing gateway runtime']);
});
