import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { resolveChainConfig } from '@antseed/node';
import { registerRoutes } from './routes.js';
import { loadCryptoContext, type CryptoContext, type PaymentCryptoConfig } from './crypto-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PaymentsServerOptions {
  port: number;
  dataDir?: string;
  configPath?: string;
  chainOverrides?: Record<string, unknown>;
  identityHex?: string;
  /**
   * Fallback RPC URL used when the user has not set `payments.crypto.rpcUrl`
   * in config.json. Lets the host app (e.g. desktop) override the protocol
   * default (`mainnet.base.org`) with a more reliable endpoint, matching the
   * RPC the rest of the app is already using for on-chain reads.
   */
  defaultRpcUrl?: string;
  /**
   * Called when a pay page reports a completed payment action (deposit,
   * withdraw, claim, channel close). Lets the host app refocus its window
   * and refresh balances immediately instead of waiting for a poll.
   */
  onPaymentCompleted?: () => void;
  /** Compatibility entry for retired claim pages. Opens the unified dashboard. */
  onOpenRewards?: () => Promise<void>;
}

export async function createServer(options: PaymentsServerOptions) {
  const fastify = Fastify({ logger: false });

  // Generate a bearer token for this session — only the desktop app knows it
  const bearerToken = randomBytes(32).toString('hex');

  // Restrict CORS to same-origin only (portal frontend is served from the same host)
  const portalOrigin = `http://127.0.0.1:${options.port}`;
  await fastify.register(fastifyCors, { origin: portalOrigin });

  // Authenticate API requests with bearer token (skip for static files and GET /api/config)
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.method === 'GET' && request.url.startsWith('/api/config')) return;
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${bearerToken}`) {
      return reply.status(401).send({ ok: false, error: 'Unauthorized' });
    }
  });

  // Serve static web files
  const webDir = path.resolve(__dirname, 'web');
  let staticRegistered = false;
  try {
    await fastify.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
    });
    staticRegistered = true;
  } catch {
    // Web dir may not exist in dev mode or CLI headless use
  }

  // Load crypto context (identity)
  let cryptoCtx: CryptoContext | null = null;
  try {
    cryptoCtx = await loadCryptoContext({
      identityHex: options.identityHex,
      dataDir: options.dataDir,
    });
  } catch (err) {
    console.warn('[payments] Failed to load crypto context:', err instanceof Error ? err.message : String(err));
  }

  // Resolve chain config: protocol defaults + user overrides from config.json
  let userOverrides: Record<string, unknown> = {};
  let proxyPort = 8377;
  try {
    const cfgPath = options.configPath ?? (options.dataDir
      ? path.join(options.dataDir, 'config.json')
      : path.join(homedir(), '.antseed', 'config.json'));
    const raw = await readFile(cfgPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const payments = (config.payments ?? {}) as Record<string, unknown>;
    userOverrides = (payments.crypto ?? {}) as Record<string, unknown>;
    const buyer = (config.buyer ?? {}) as Record<string, unknown>;
    if (typeof buyer.proxyPort === 'number') {
      proxyPort = buyer.proxyPort;
    }
  } catch {
    // No config file — use protocol defaults
  }

  userOverrides = { ...userOverrides, ...options.chainOverrides };
  const userRpcUrl = typeof userOverrides.rpcUrl === 'string' && userOverrides.rpcUrl.trim().length > 0
    ? (userOverrides.rpcUrl as string)
    : undefined;
  const selectedChainId = (userOverrides.chainId as string | undefined) ?? 'base-mainnet';
  // Only fall back to the host's preferred RPC for base-mainnet — the only
  // chain whose protocol default (mainnet.base.org) rate-limits the channels
  // enrichment fan-out. Other chains keep their own presets.
  const effectiveRpcUrl = userRpcUrl ?? (selectedChainId === 'base-mainnet' ? options.defaultRpcUrl : undefined);
  const chainConfig = resolveChainConfig({
    chainId: userOverrides.chainId as string | undefined,
    ...(effectiveRpcUrl ? { rpcUrl: effectiveRpcUrl } : {}),
    ...(Array.isArray(userOverrides.fallbackRpcUrls)
      ? { fallbackRpcUrls: userOverrides.fallbackRpcUrls as string[] }
      : {}),
    depositsContractAddress: userOverrides.depositsContractAddress as string | undefined,
    channelsContractAddress: userOverrides.channelsContractAddress as string | undefined,
    usdcContractAddress: userOverrides.usdcContractAddress as string | undefined,
  });

  const cryptoConfig: PaymentCryptoConfig = {
    rpcUrl: chainConfig.rpcUrl,
    ...(chainConfig.fallbackRpcUrls ? { fallbackRpcUrls: chainConfig.fallbackRpcUrls } : {}),
    depositsContractAddress: chainConfig.depositsContractAddress,
    channelsContractAddress: chainConfig.channelsContractAddress,
    usdcContractAddress: chainConfig.usdcContractAddress,
  };

  registerRoutes(fastify, { cryptoCtx, cryptoConfig, chainConfig, proxyPort });

  fastify.post('/api/pay/open-rewards', async (_request, reply) => {
    if (!options.onOpenRewards) return reply.status(409).send({ ok: false, error: 'Open the ANTS dashboard with antseed ants, using this account’s data directory, then select Rewards.' });
    try { await options.onOpenRewards(); return { ok: true }; }
    catch (error) { return reply.status(500).send({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
  });

  // Pay pages report completion here (bearer-protected like all /api routes)
  // so the host app can refocus its window and refresh balances right away.
  fastify.post('/api/pay/completed', async () => {
    try {
      options.onPaymentCompleted?.();
    } catch {
      // Host callback failures must not fail the pay page.
    }
    return { ok: true };
  });

  // SPA fallback — only if static files are available
  if (staticRegistered) {
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/assets/')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      void reply.sendFile('index.html');
    });
  }

  (fastify as unknown as { bearerToken: string }).bearerToken = bearerToken;

  return fastify;
}
