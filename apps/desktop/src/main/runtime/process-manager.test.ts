import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCliChildEnv, ProcessManager, resolveCommandArgs } from './process-manager.js';
import { setDesktopTelemetryChoiceInConfig, setDesktopTelemetryHost } from '../telemetry/host-env.js';

test('local desktop CLI runs may prepare trusted plugins', () => {
  const env = buildCliChildEnv({ ANTSEED_SKIP_PLUGIN_UPDATE_CHECK: '1' }, true);
  assert.equal(env['ANTSEED_SKIP_PLUGIN_UPDATE_CHECK'], undefined);
});

test('packaged desktop CLI runs remain offline-only', () => {
  const env = buildCliChildEnv({}, false);
  assert.equal(env['ANTSEED_SKIP_PLUGIN_UPDATE_CHECK'], '1');
});

test('CLI children attribute their usage to the Desktop client id', () => {
  assert.equal(buildCliChildEnv({}, false)['ANTSEED_CLIENT_KIND'], 'desktop');
  assert.equal(buildCliChildEnv({ ANTSEED_CLIENT_KIND: 'cli' }, true)['ANTSEED_CLIENT_KIND'], 'desktop');
});

test('CLI children are told the desktop hosts them, and are off when desktop telemetry cannot run', () => {
  setDesktopTelemetryChoiceInConfig(true);
  setDesktopTelemetryHost({ sessionId: '0190a6e2-7b3c-7d4e-8f00-000000000001', available: false });
  const env = buildCliChildEnv({}, false);
  assert.equal(env['ANTSEED_TELEMETRY_HOST'], 'desktop');
  assert.equal(env['ANTSEED_TELEMETRY_HOST_SESSION_ID'], '0190a6e2-7b3c-7d4e-8f00-000000000001');
  assert.equal(env['ANTSEED_TELEMETRY'], '0');
  setDesktopTelemetryChoiceInConfig(false);
});

test('the user choice reaches CLI children through the config, not a fixed env off switch', () => {
  setDesktopTelemetryHost({ sessionId: '0190a6e2-7b3c-7d4e-8f00-000000000001', available: true });
  // The choice is not in the config yet (or writing it failed): a buyer started now must not send on a stale `true`.
  setDesktopTelemetryChoiceInConfig(false);
  assert.equal(buildCliChildEnv({}, false)['ANTSEED_TELEMETRY'], '0');
  // Once the config holds it, no env switch: a buyer started with telemetry off
  // turns on live when the user enables it in Preferences.
  setDesktopTelemetryChoiceInConfig(true);
  assert.equal(buildCliChildEnv({}, false)['ANTSEED_TELEMETRY'], undefined);
  setDesktopTelemetryChoiceInConfig(false);
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

