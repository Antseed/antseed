#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Wallet } from 'ethers';
import { ChannelsClient } from '@antseed/node';
import { generateWorkerEncryptionKey, type WorkerEncryptionKey } from '@antseed/node/worker-e2e';
import { PoolWorker, type ChannelVerifier } from './worker.js';

const USAGE = `Usage: antseed-pool-worker --pool <wss://url> --services <service[=localModel],...> [options]

Joins an Antseed colony pool and serves its requests from a local
OpenAI-compatible model server (mlx_lm.server, Ollama, llama.cpp).

Options:
  --pool <url>          Pool WebSocket URL
  --services <list>     Services to serve, each optionally mapped to a local model name
  --base-url <url>      Local model server (default http://127.0.0.1:8080)
  --concurrency <n>     Requests to run at once (default 1)
  --key-file <path>     Worker key; created on first run (default ~/.antseed-worker/key).
                        The encryption key is kept next to it as <path>.p256.
  --rpc-url <url>       Base RPC; with it, the worker checks that each request's
                        channel belongs to a buyer of this pool
  --stats               Print this worker's earnings and exit
`;

function loadOrCreateKey(path: string): string {
  if (existsSync(path)) return readFileSync(path, 'utf-8').trim();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = Wallet.createRandom().privateKey;
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

function loadOrCreateEncryptionKey(path: string): WorkerEncryptionKey {
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, 'utf-8')) as { publicKey: string; privateKey: string };
    return { publicKey: Buffer.from(stored.publicKey, 'hex'), privateKey: Buffer.from(stored.privateKey, 'hex') };
  }
  const key = generateWorkerEncryptionKey();
  writeFileSync(path, `${JSON.stringify({ publicKey: Buffer.from(key.publicKey).toString('hex'), privateKey: Buffer.from(key.privateKey).toString('hex') })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

/** Reads the channel through the pool's seller contract, which resolves the real channels contract. */
function channelVerifier(rpcUrl: string): ChannelVerifier {
  const clients = new Map<string, ChannelsClient>();
  return async (channel, buyer, seller) => {
    const client = clients.get(seller) ?? new ChannelsClient({ rpcUrl, contractAddress: seller });
    clients.set(seller, client);
    const session = await client.getSession(channel);
    if (/^0x0+$/.test(session.buyer)) return null; // not visible yet
    return session.buyer.toLowerCase() === buyer.toLowerCase() && session.seller.toLowerCase() === seller.toLowerCase();
  };
}

function parseServices(raw: string): Record<string, string> {
  return Object.fromEntries(raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [service, localModel] = entry.split('=', 2) as [string, string | undefined];
    return [service.trim(), (localModel ?? service).trim()];
  }));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      pool: { type: 'string' },
      services: { type: 'string' },
      'base-url': { type: 'string', default: 'http://127.0.0.1:8080' },
      concurrency: { type: 'string', default: '1' },
      'key-file': { type: 'string', default: join(homedir(), '.antseed-worker', 'key') },
      'rpc-url': { type: 'string' },
      stats: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !values.pool || (!values.services && !values.stats)) {
    process.stdout.write(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const concurrency = Number.parseInt(values.concurrency!, 10);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive whole number');

  const worker = new PoolWorker({
    poolUrl: values.pool,
    baseUrl: values['base-url']!,
    services: values.services ? parseServices(values.services) : {},
    privateKey: loadOrCreateKey(values['key-file']!),
    encryptionKey: loadOrCreateEncryptionKey(`${values['key-file']!}.p256`),
    ...(values['rpc-url'] ? { channelVerifier: channelVerifier(values['rpc-url']) } : {}),
    maxConcurrency: concurrency,
    log: (line) => console.log(line),
  });
  console.log(`worker address (payouts go here): ${worker.address}`);
  worker.start();

  if (values.stats) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const stats = await worker.requestStats();
    const usdc = (units: string): string => (Number(units) / 1e6).toFixed(6);
    console.log(`earned today ${usdc(stats.earnedToday)} · 7 days ${usdc(stats.earnedLast7Days)} · total ${usdc(stats.earnedTotal)} USDC`);
    console.log(`paid ${usdc(stats.paidTotal)} · pending ${usdc(stats.pending)} USDC · ${stats.requestsTotal} requests`);
    worker.stop();
    return;
  }

  const shutdown = (): void => {
    worker.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
