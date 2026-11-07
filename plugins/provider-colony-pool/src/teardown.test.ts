import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import plugin from './index.js';

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function occupy(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  servers.push(server);
}

/** Whether something can listen on `port` now. */
async function canBind(port: number, host = '127.0.0.1'): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function config(port: number, extra: Record<string, string> = {}): Record<string, string> {
  const dataDir = mkdtempSync(join(tmpdir(), 'colony-pool-teardown-'));
  dirs.push(dataDir);
  return {
    ANTSEED_ALLOWED_SERVICES: 'qwen',
    ANTSEED_INPUT_USD_PER_MILLION: '1',
    ANTSEED_OUTPUT_USD_PER_MILLION: '2',
    ANTSEED_DATA_DIR: dataDir,
    COLONY_POOL_SELLER_ADDRESS: `0x${'aa'.repeat(20)}`,
    COLONY_POOL_PORT: String(port),
    COLONY_POOL_HOST: '127.0.0.1',
    ...extra,
  };
}

type Lifecycle = { init(): Promise<void>; stop(): Promise<void> };

describe('the colony pool provider lifecycle', () => {
  it('releases its worker port and connections on stop, so a replacement can start on the same port', async () => {
    const port = await freePort();
    const first = plugin.createProvider(config(port)) as unknown as Lifecycle;
    await first.init();
    const worker = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => worker.once('open', resolve));
    const closed = new Promise((resolve) => worker.once('close', resolve));

    await first.stop();
    await closed;
    await first.stop(); // a second stop is a no-op

    const second = plugin.createProvider(config(port)) as unknown as Lifecycle;
    await expect(second.init()).resolves.toBeUndefined();
    await second.stop();
    expect(await canBind(port)).toBe(true);
  });

  it('rolls back what it opened when init fails partway', async () => {
    const port = await freePort();
    const webhookPort = await freePort();
    await occupy(port);
    const provider = plugin.createProvider(config(port, {
      COLONY_POOL_MDM_URL: 'http://127.0.0.1:9/',
      COLONY_POOL_MDM_WEBHOOK_PORT: String(webhookPort),
      COLONY_POOL_MDM_WEBHOOK_PATH: 'a'.repeat(32),
    })) as unknown as Lifecycle;
    // The MDM webhook starts, then the worker port is taken.
    await expect(provider.init()).rejects.toThrow(/EADDRINUSE/);
    // The webhook listens on every interface.
    expect(await canBind(webhookPort, '0.0.0.0')).toBe(true);
  });
});
