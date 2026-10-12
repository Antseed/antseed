import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { AbstractSigner } from 'ethers';
import { loadOrCreateIdentity, resolveChainConfig } from '@antseed/node';
import { AntsContext, type AntsChainConfig } from './service/context.js';
import { JobRunner } from './jobs.js';
import { assertSelectedWallet, registerRoutes } from './routes.js';
import { BrowserSigning } from './browser-signer.js';
import { getAddress, ZeroAddress, id as eventId } from 'ethers';
import { ViewCache } from './view-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AntsServerOptions {
  port: number;
  /** Browser wallet signing (default). Set false only for explicit local service test harnesses. */
  browserWallet?: boolean;
  onAuthorize?: () => Promise<void>;
  host?: string;
  /** Node data directory holding the identity wallet (default ~/.antseed). */
  dataDir?: string;
  /** Config file with `payments.crypto` overrides (default <dataDir>/config.json). */
  configPath?: string;
  /** Pre-resolved chain config; skips reading config.json. */
  chain?: AntsChainConfig;
  /** Explicit signer/address; skips loading the identity from disk. */
  signer?: AbstractSigner;
  address?: string;
  selectedAddress?: string;
  /** Serve a read-only dashboard for `address` without a signer. */
  readOnly?: boolean;
  /** Notify the host after an action finishes, including failed actions. */
  onActionFinished?: () => void;
}

export interface AntsServer {
  app: FastifyInstance;
  token: string;
  url: string;
  context: AntsContext;
  readonly busy: boolean;
  pauseWrites(): void;
  listen(): Promise<string>;
  close(): Promise<void>;
}

async function readCryptoOverrides(configPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf-8')) as { payments?: { crypto?: Record<string, unknown> } };
    return parsed.payments?.crypto ?? {};
  } catch {
    return {};
  }
}

/** Resolve the chain config the same way the CLI does: protocol defaults + `payments.crypto` overrides + ANTSEED_BASE_RPC_URL. */
export async function resolveAntsChain(configPath: string, env: NodeJS.ProcessEnv = process.env): Promise<AntsChainConfig> {
  const overrides = await readCryptoOverrides(configPath);
  const rpcOverride = env['ANTSEED_BASE_RPC_URL']?.trim();
  const resolved = resolveChainConfig({ ...(overrides as object), ...(rpcOverride ? { rpcUrl: rpcOverride } : {}) });
  return { ...resolved, ...(overrides as object), rpcUrl: rpcOverride || (overrides['rpcUrl'] as string | undefined) || resolved.rpcUrl } as AntsChainConfig;
}

export async function createAntsServer(options: AntsServerOptions): Promise<AntsServer> {
  const host = options.host ?? '127.0.0.1';
  const browserWallet = options.browserWallet !== false;
  const selectedAddress = options.selectedAddress ? getAddress(options.selectedAddress) : undefined;
  if (selectedAddress === ZeroAddress) throw new Error('Select a non-zero account address.');
  if (selectedAddress && !browserWallet) throw new Error('Account selection requires browser wallet signing.');
  const dataDir = options.dataDir ?? path.join(homedir(), '.antseed');
  const configPath = options.configPath ?? path.join(dataDir, 'config.json');
  const chain = options.chain ?? await resolveAntsChain(configPath);

  let signer = browserWallet ? undefined : options.signer;
  let address = selectedAddress ?? options.address;
  if (!signer && !options.readOnly && !browserWallet) {
    const identity = await loadOrCreateIdentity(dataDir);
    signer = identity.wallet;
    address = identity.wallet.address;
  }
  if (!address) throw new Error('An address is required for a read-only dashboard.');
  const readOnly = !signer;
  const browserSigning = browserWallet ? new BrowserSigning(chain.evmChainId) : undefined;
  const context = new AntsContext({ chain, address, ...(signer ? { signer } : {}) });
  if (browserSigning && !selectedAddress) context.address = ZeroAddress;
  const originBuyer = context.buyerAddress;
  /** The buyer account a connected wallet manages: the originating buyer when the wallet is that buyer or its authorized operator, otherwise the wallet itself. */
  const buyerAccountFor = async (wallet: string | null): Promise<string> => {
    if (!wallet || wallet.toLowerCase() === originBuyer.toLowerCase()) return originBuyer;
    try {
      const operator = await context.deposits()?.getOperator(originBuyer);
      if (operator && operator.toLowerCase() === wallet.toLowerCase()) return originBuyer;
    } catch {
      return originBuyer;
    }
    return wallet;
  };
  await context.selectRpc();

  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return payload;
  });
  const token = randomBytes(24).toString('hex');
  let origin = `http://${host}:${options.port}`;
  await app.register(fastifyCors, { origin: (requestOrigin, callback) => callback(null, requestOrigin === origin) });

  // Every API call carries the per-session token the CLI put in the URL fragment;
  // a page on another origin cannot read it, and a stray tab cannot sign.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const header = request.headers.authorization;
    if (header !== `Bearer ${token}`) return reply.status(401).send({ ok: false, error: 'Unauthorized' });
  });

  const webDir = path.resolve(__dirname, 'ants-web');
  try {
    await app.register(fastifyStatic, { root: webDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({ ok: false, error: 'Not found' });
      return reply.sendFile('index.html');
    });
  } catch {
    // No web bundle (dev mode); the API is still available for the Vite dev server.
  }

  const views = new ViewCache();
  const historyPath = path.join(dataDir, 'ants-activity', `${chain.evmChainId}-positions.json`);
  try {
    const saved = JSON.parse(await readFile(historyPath, 'utf8')) as Array<[number, string]>;
    for (const [positionId, owner] of saved) if (Number.isSafeInteger(positionId) && positionId > 0 && /^0x[0-9a-fA-F]{40}$/.test(owner)) context.localPositionIds.set(positionId, owner);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read local position history. Preserve the file and resolve the error before continuing.', { cause: error }); }
  const rememberTransaction = async (hash: string) => {
    const receipt = await context.provider().getTransactionReceipt(hash);
    if (!receipt || receipt.status !== 1) return;
    const wallet = receipt.from.toLowerCase();
    const previous = context.positionReadBarriers.get(wallet);
    context.positionReadBarriers.set(wallet, { block: Math.max(previous?.block ?? 0, receipt.blockNumber), at: Math.max(previous?.at ?? 0, Math.floor(Date.now() / 1000)) });
    const ids = receipt.logs.filter(log => log.address.toLowerCase() === chain.sellerPoolsAddress?.toLowerCase() && log.topics.length === 4 && log.topics[0] === eventId('Transfer(address,address,uint256)')).map(log => Number(BigInt(log.topics[3]!)));
    if (!ids.length) return;
    const positions = await context.requirePools().positionsBatch([...new Set(ids)]);
    for (const position of positions) if (position.owner.toLowerCase() === context.address.toLowerCase()) context.localPositionIds.set(position.id, position.owner);
    await mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
    const temporary = `${historyPath}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify([...context.localPositionIds]), { mode: 0o600 });
    await rename(temporary, historyPath);
  };
  // Browser sessions have no wallet at startup; one journal per chain, with jobs tagged by owner.
  const journalPath = path.join(dataDir, 'ants-activity', browserSigning ? `${chain.evmChainId}-browser.json` : `${chain.evmChainId}-${context.address.toLowerCase()}.json`);
  const jobs = new JobRunner({
    onFinish: () => {
      views.invalidate();
      // A host refresh failure must not turn a successful transaction into a failed job.
      try { options.onActionFinished?.(); } catch { /* The host can refresh on focus. */ }
    },
    ...(!readOnly || browserSigning ? { journalPath } : {}),
  });
  registerRoutes(app, { ctx: context, jobs, views, readOnly, dataDir, selectedAddress, originBuyer, browserSigning, onAuthorize: options.onAuthorize, rememberTransaction });
  if (browserSigning) {
    app.post<{ Body: { address?: string; chainId?: number; refresh?: boolean; disconnect?: boolean } }>('/api/wallet', async (request, reply) => {
      const body = request.body ?? {};
      try {
        const next = body.address ? getAddress(body.address) : null;
        if (next === ZeroAddress) throw new Error('Connect a non-zero wallet address.');
        if (next && body.chainId !== chain.evmChainId) throw new Error('Switch your wallet to the dashboard network.');
        const current = await context.signer?.getAddress() ?? null;
        if (next && selectedAddress && !jobs.busy) await assertSelectedWallet(context, selectedAddress, next, 'connection');
        // A tab without a wallet (still reconnecting, or a second tab opened from VPR) must not
        // downgrade the connected session; only an explicit disconnect clears the signer.
        if (next === current || (next === null && !body.disconnect)) {
          // A no-op initial sync must not discard reads already loading. An explicit
          // focus refresh still rechecks permissions after the authorization flow.
          if (body.refresh) { context.invalidate({ walletOnly: true }); views.invalidate(); }
          return { ok: true, data: { changed: false } };
        }
        // Check before cancelling: a refused switch must not poison the running job's signer.
        if (jobs.busy && !(next === null && body.disconnect)) return reply.code(409).send({ ok: false, error: 'Waiting for the previous wallet action to finish. Submitted transactions are still tracked.' });
        browserSigning.cancel();
        context.address = selectedAddress ?? next ?? context.address;
        if (!selectedAddress) context.buyerAddress = await buyerAccountFor(next);
        context.signer = next ? browserSigning.signer(next, context.provider()) : undefined;
        context.invalidate({ walletOnly: true }); views.invalidate();
        return { ok: true, data: { changed: true } };
      } catch (error) {
        if (selectedAddress && !jobs.busy) {
          browserSigning.cancel();
          context.signer = undefined;
          context.invalidate({ walletOnly: true }); views.invalidate();
        }
        return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    app.post<{ Body: { id: string } }>('/api/wallet/begin', async (request, reply) => {
      try { browserSigning.begin(request.body.id); return { ok: true, data: {} }; }
      catch (error) { return reply.code(409).send({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
    app.get('/api/wallet/request', async () => {
      const transaction = browserSigning.request;
      const job = transaction ? jobs.list(selectedAddress ?? transaction.from).find(job => job.status === 'running') : undefined;
      return { ok: true, data: transaction ? { ...transaction, ...(job ? { jobId: job.id } : {}) } : null };
    });
    app.post<{ Body: { id: string; hash?: string; error?: string } }>('/api/wallet/result', async (request, reply) => {
      try { await browserSigning.complete(request.body.id, request.body.hash, request.body.error); return { ok: true, data: {} }; }
      catch (error) { return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
  }

  const sessionUrl = () => `${origin}/#token=${token}`;
  return {
    app,
    token,
    get url() { return sessionUrl(); },
    context,
    get busy() { return jobs.busy; },
    pauseWrites: () => jobs.pauseWrites(),
    async listen() {
      origin = await app.listen({ port: options.port, host });
      return sessionUrl();
    },
    async close() {
      browserSigning?.cancel('Dashboard session ended.');
      await app.close();
    },
  };
}
