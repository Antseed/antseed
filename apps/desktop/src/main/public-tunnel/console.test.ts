import assert from 'node:assert/strict';
import test from 'node:test';
import { consoleLinkArgs, createTunnelConsole, parseConsoleLinkOutput, parseTunnelLocation, type TunnelLocation } from './console.js';

const LOCATION: TunnelLocation = { publicOrigin: 'https://example.ngrok.app', gatewayPort: 8379 };

function harness(options: { location?: TunnelLocation | null; setupRequired?: boolean; fetchFails?: boolean; cliStdout?: string } = {}) {
  const fetched: string[] = [];
  const cliCalls: string[][] = [];
  const opened: string[] = [];
  const tunnelConsole = createTunnelConsole({
    readLocation: async () => (options.location === undefined ? LOCATION : options.location),
    dataDir: () => '/data/connect',
    fetch: async (url) => {
      fetched.push(url);
      if (options.fetchFails) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ setupRequired: options.setupRequired ?? true }) };
    },
    runCli: async (args) => {
      cliCalls.push(args);
      return options.cliStdout ?? '';
    },
    openExternal: async (url) => { opened.push(url); },
  });
  return { tunnelConsole, fetched, cliCalls, opened };
}

test('parseTunnelLocation keeps the https origin and gateway port', () => {
  assert.deepEqual(parseTunnelLocation({ publicUrl: 'https://example.ngrok.app/', gatewayPort: 8379 }), LOCATION);
  assert.equal(parseTunnelLocation({ publicUrl: 'http://example.com', gatewayPort: 8379 }), null);
  assert.equal(parseTunnelLocation({ publicUrl: 'https://example.com' }), null);
  assert.equal(parseTunnelLocation(null), null);
});

test('consoleLinkArgs points the link at the public origin in the tunnel data dir', () => {
  assert.deepEqual(consoleLinkArgs('/data/connect', 'https://example.ngrok.app'), [
    '--data-dir', '/data/connect', 'gateway', 'console-link', '--public-url', 'https://example.ngrok.app', '--json',
  ]);
});

test('parseConsoleLinkOutput reads the JSON line and rejects anything else', () => {
  const out = 'Warning: something\n{"url":"https://x.app/console","setupRequired":true,"setupLink":"https://x.app/console/setup#t"}\n';
  assert.deepEqual(parseConsoleLinkOutput(out), { url: 'https://x.app/console', setupRequired: true, setupLink: 'https://x.app/console/setup#t' });
  assert.throws(() => parseConsoleLinkOutput('not json'));
});

test('status reads setupRequired from the local gateway', async () => {
  const unclaimed = harness({ setupRequired: true });
  assert.deepEqual(await unclaimed.tunnelConsole.status(), { state: 'unclaimed', url: 'https://example.ngrok.app/console' });
  assert.deepEqual(unclaimed.fetched, ['http://127.0.0.1:8379/console/api/auth/config']);
  assert.equal((await harness({ setupRequired: false }).tunnelConsole.status()).state, 'claimed');
  assert.equal((await harness({ fetchFails: true }).tunnelConsole.status()).state, 'unavailable');
  assert.deepEqual(await harness({ location: null }).tunnelConsole.status(), { state: 'unavailable', url: null });
});

test('claim mints a setup link and opens it', async () => {
  const link = 'https://example.ngrok.app/console/setup#token';
  const h = harness({ cliStdout: JSON.stringify({ url: 'https://example.ngrok.app/console', setupRequired: true, setupLink: link }) });
  const result = await h.tunnelConsole.claim();
  assert.equal(result.ok, true);
  assert.deepEqual(h.cliCalls, [consoleLinkArgs('/data/connect', 'https://example.ngrok.app')]);
  assert.deepEqual(h.opened, [link]);
});

test('claim opens the console when it already has an owner', async () => {
  const h = harness({ cliStdout: JSON.stringify({ url: 'https://example.ngrok.app/console', setupRequired: false, setupLink: null }) });
  const result = await h.tunnelConsole.claim();
  assert.deepEqual(result.status, { state: 'claimed', url: 'https://example.ngrok.app/console' });
  assert.deepEqual(h.opened, ['https://example.ngrok.app/console']);
});

test('claim refuses without a running tunnel', async () => {
  const h = harness({ location: null });
  const result = await h.tunnelConsole.claim();
  assert.equal(result.ok, false);
  assert.deepEqual(h.cliCalls, []);
  assert.deepEqual(h.opened, []);
});
