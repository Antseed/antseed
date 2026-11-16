import type { FastifyInstance } from 'fastify';
import type { CryptoContext, PaymentCryptoConfig } from './crypto-context.js';
import {
  DepositsClient,
  EmissionsClient,
  EmissionsGateClient,
  resolveLegacyContractAddresses,
  UsageAccountingClient,
  UsageRewardsClient,
  ANTSTokenClient,
  formatUsdc,
  signSetOperator,
  makeDepositsDomain,
  type ChainConfig,
  type BuyerUsageTotals,
} from '@antseed/node';

const EMPTY_BUYER_USAGE: BuyerUsageTotals = {
  totalRequests: 0,
  totalInputTokens: '0',
  totalOutputTokens: '0',
  totalSettlements: 0,
  uniqueSellers: 0,
  activeChannels: 0,
  channels: [],
  services: [],
};

interface RouteContext {
  cryptoCtx: CryptoContext | null;
  cryptoConfig: PaymentCryptoConfig;
  chainConfig: ChainConfig;
  proxyPort: number;
}

// Use shared utilities from @antseed/node
const formatUsdc6 = formatUsdc;
const RPC_READ_ATTEMPTS = 2;

// Retry helper for on-chain view calls. Base RPC occasionally returns an
// unparseable response (ethers surfaces it as CALL_EXCEPTION with null
// revert data even though the call didn't actually revert); view calls are
// idempotent, so retrying clears these transient failures.
async function retryRead<T>(fn: () => Promise<T>, attempts = RPC_READ_ATTEMPTS): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 150 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

function createClient(config: PaymentCryptoConfig, evmChainId?: number): DepositsClient {
  return new DepositsClient({
    rpcUrl: config.rpcUrl,
    ...(config.fallbackRpcUrls ? { fallbackRpcUrls: config.fallbackRpcUrls } : {}),
    contractAddress: config.depositsContractAddress,
    usdcAddress: config.usdcContractAddress,
    evmChainId,
  });
}

export function registerRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  // Shared deposits client — reused across requests (stateless, only holds RPC URL + ABI)
  let depositsClient: DepositsClient | null = null;
  function getClient(): DepositsClient | null {
    if (!depositsClient) depositsClient = createClient(ctx.cryptoConfig, ctx.chainConfig.evmChainId);
    return depositsClient;
  }

  // After cutover, the primary emissions slot points to UsageAccounting, not
  // the legacy reward contract expected by these claim endpoints and their UI.
  const legacyAddresses = resolveLegacyContractAddresses(ctx.chainConfig);
  const claimContractAddress = legacyAddresses.legacyEmissionsContractAddress;
  let emissionsClient: EmissionsClient | null = null;
  function getEmissionsClient(): EmissionsClient | null {
    if (!claimContractAddress) return null;
    if (!emissionsClient) {
      emissionsClient = new EmissionsClient({
        rpcUrl: ctx.cryptoConfig.rpcUrl,
        ...(ctx.cryptoConfig.fallbackRpcUrls ? { fallbackRpcUrls: ctx.cryptoConfig.fallbackRpcUrls } : {}),
        contractAddress: claimContractAddress,
        evmChainId: ctx.chainConfig.evmChainId,
      });
    }
    return emissionsClient;
  }

  let legacyEmissionsClient: EmissionsClient | null = null;
  function getLegacyEmissionsClient(): EmissionsClient | null {
    if (!legacyAddresses.legacyEmissionsV1ContractAddress) return null;
    if (!legacyEmissionsClient) {
      legacyEmissionsClient = new EmissionsClient({
        rpcUrl: ctx.cryptoConfig.rpcUrl,
        ...(ctx.cryptoConfig.fallbackRpcUrls ? { fallbackRpcUrls: ctx.cryptoConfig.fallbackRpcUrls } : {}),
        contractAddress: legacyAddresses.legacyEmissionsV1ContractAddress,
        evmChainId: ctx.chainConfig.evmChainId,
      });
    }
    return legacyEmissionsClient;
  }

  const emissionsGate = ctx.chainConfig.emissionsGateAddress ? new EmissionsGateClient({
    rpcUrl: ctx.cryptoConfig.rpcUrl,
    ...(ctx.cryptoConfig.fallbackRpcUrls ? { fallbackRpcUrls: ctx.cryptoConfig.fallbackRpcUrls } : {}),
    contractAddress: ctx.chainConfig.emissionsGateAddress,
    evmChainId: ctx.chainConfig.evmChainId,
  }) : null;

  let usageAccountingClient: UsageAccountingClient | null = null;
  function getUsageAccountingClient(): UsageAccountingClient | null {
    if (!ctx.chainConfig.usageAccountingAddress) return null;
    if (!usageAccountingClient) {
      usageAccountingClient = new UsageAccountingClient({
        rpcUrl: ctx.cryptoConfig.rpcUrl,
        ...(ctx.cryptoConfig.fallbackRpcUrls ? { fallbackRpcUrls: ctx.cryptoConfig.fallbackRpcUrls } : {}),
        contractAddress: ctx.chainConfig.usageAccountingAddress,
        evmChainId: ctx.chainConfig.evmChainId,
      });
    }
    return usageAccountingClient;
  }

  let usageRewardsClient: UsageRewardsClient | null = null;
  function getUsageRewardsClient(): UsageRewardsClient | null {
    if (!ctx.chainConfig.usageRewardsAddress) return null;
    if (!usageRewardsClient) {
      usageRewardsClient = new UsageRewardsClient({
        rpcUrl: ctx.cryptoConfig.rpcUrl,
        ...(ctx.cryptoConfig.fallbackRpcUrls ? { fallbackRpcUrls: ctx.cryptoConfig.fallbackRpcUrls } : {}),
        contractAddress: ctx.chainConfig.usageRewardsAddress,
        evmChainId: ctx.chainConfig.evmChainId,
      });
    }
    return usageRewardsClient;
  }

  let antsTokenClient: ANTSTokenClient | null = null;
  function getAntsTokenClient(): ANTSTokenClient | null {
    // ANTSToken address is typically fetched via the registry, but for v1 we
    // plumb it through the chain config. Fall back to null if unavailable.
    const addr = ctx.chainConfig.antsTokenAddress;
    if (!addr) return null;
    if (!antsTokenClient) {
      antsTokenClient = new ANTSTokenClient({
        rpcUrl: ctx.cryptoConfig.rpcUrl,
        contractAddress: addr,
        evmChainId: ctx.chainConfig.evmChainId,
      });
    }
    return antsTokenClient;
  }

  fastify.get('/api/balance', async (_request, reply) => {
    if (!ctx.cryptoCtx) {
      return reply.status(503).send({ ok: false, error: 'Identity not configured — set ANTSEED_IDENTITY_HEX or run antseed seller setup' });
    }

    try {
      const client = getClient()!;
      const buyerAddress = ctx.cryptoCtx.evmAddress;

      const [balance, creditLimit] = await Promise.all([
        retryRead(() => client.getBuyerBalance(buyerAddress)),
        retryRead(() => client.getBuyerCreditLimit(buyerAddress)),
      ]);

      return {
        evmAddress: ctx.cryptoCtx.evmAddress,
        available: formatUsdc6(balance.available),
        reserved: formatUsdc6(balance.reserved),
        total: formatUsdc6(balance.available + balance.reserved),
        creditLimit: formatUsdc6(creditLimit),
      };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get('/api/config', async () => {
    return {
      chainId: ctx.chainConfig.chainId,
      evmChainId: ctx.chainConfig.evmChainId,
      rpcUrl: ctx.cryptoConfig.rpcUrl,
      depositsContractAddress: ctx.cryptoConfig.depositsContractAddress,
      channelsContractAddress: ctx.cryptoConfig.channelsContractAddress,
      usdcContractAddress: ctx.cryptoConfig.usdcContractAddress,
      emissionsContractAddress: claimContractAddress ?? null,
      legacyEmissionsContractAddress: ctx.chainConfig.recognizedUsage?.status === 'active'
        ? ctx.chainConfig.legacyEmissionsContractAddress ?? null
        : ctx.chainConfig.emissionsContractAddress ?? null,
      usageAccountingAddress: ctx.chainConfig.usageAccountingAddress ?? null,
      usageRewardsAddress: ctx.chainConfig.usageRewardsAddress ?? null,
      recognizedUsageEffectiveEpoch: ctx.chainConfig.recognizedUsage?.status === 'active'
        ? ctx.chainConfig.recognizedUsage.effectiveEpoch
        : null,
      antsTokenAddress: ctx.chainConfig.antsTokenAddress ?? null,
      networkStatsUrl: ctx.chainConfig.networkStatsUrl ?? null,
      evmAddress: ctx.cryptoCtx?.evmAddress ?? null,
    };
  });

  fastify.get('/api/rpc-health', async (_request, reply) => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(ctx.cryptoConfig.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_blockNumber',
          params: [],
        }),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null) as {
        result?: string;
        error?: { message?: string };
      } | null;
      if (!res.ok || !body?.result || body.error) {
        const error = body?.error?.message ?? `RPC returned HTTP ${res.status}`;
        return reply.status(502).send({ ok: false, error });
      }
      return {
        ok: true,
        blockNumber: Number.parseInt(body.result, 16),
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      const error = err instanceof Error && err.name === 'AbortError'
        ? 'RPC request timed out'
        : err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ ok: false, error });
    } finally {
      clearTimeout(timeout);
    }
  });

  // Withdrawals are now submitted directly from the connected wallet
  // (see apps/payments/web/src/hooks/useWithdraw.ts). The contract requires
  // msg.sender == operator and sends funds to msg.sender, so the server-side
  // signer cannot execute withdraw once a separate wallet is authorized.

  fastify.get('/api/channels', async () => {
    if (!ctx.cryptoCtx) return { channels: [] };
    try {
      const url = `http://127.0.0.1:${ctx.proxyPort}/_antseed/channels?all=1`;
      const resp = await fetch(url);
      if (!resp.ok) {
        fastify.log.warn(`[/api/channels] buyer proxy returned ${resp.status}`);
        return { channels: [] };
      }
      const body = await resp.json() as { ok: boolean; channels: unknown[] };
      return { channels: body.channels ?? [] };
    } catch (err) {
      fastify.log.warn(`[/api/channels] buyer proxy unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return { channels: [] };
    }
  });

  fastify.get('/api/buyer-usage', async (): Promise<BuyerUsageTotals> => {
    try {
      const url = `http://127.0.0.1:${ctx.proxyPort}/_antseed/buyer-usage`;
      const resp = await fetch(url);
      if (!resp.ok) {
        fastify.log.warn(`[/api/buyer-usage] buyer proxy returned ${resp.status}`);
        return EMPTY_BUYER_USAGE;
      }
      const body = await resp.json() as { ok: boolean; totals: BuyerUsageTotals };
      return body.totals;
    } catch (err) {
      fastify.log.warn(`[/api/buyer-usage] buyer proxy unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return EMPTY_BUYER_USAGE;
    }
  });

  fastify.get('/api/operator', async (_request, reply) => {
    if (!ctx.cryptoCtx) {
      return reply.status(503).send({ ok: false, error: 'Identity not configured — set ANTSEED_IDENTITY_HEX or run antseed seller setup' });
    }

    try {
      const client = getClient();
      if (!client) {
        return { operator: '0x0000000000000000000000000000000000000000', nonce: 0 };
      }

      const buyerAddress = ctx.cryptoCtx.evmAddress;
      const [operator, nonce] = await Promise.all([
        retryRead(() => client.getOperator(buyerAddress)),
        retryRead(() => client.getOperatorNonce(buyerAddress)),
      ]);

      return { operator, nonce: Number(nonce) };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.post('/api/operator/sign', async (request, reply) => {
    if (!ctx.cryptoCtx) {
      return reply.status(503).send({ ok: false, error: 'Identity not configured' });
    }

    const body = request.body as { operator?: string } | null;
    const operator = body?.operator?.trim();
    if (!operator || !/^0x[0-9a-fA-F]{40}$/.test(operator)) {
      return reply.status(400).send({ ok: false, error: 'Invalid operator address' });
    }

    try {
      const dc = getClient();
      if (!dc) {
        return reply.status(503).send({ ok: false, error: 'Deposits contract not configured' });
      }
      const nonce = await dc.getOperatorNonce(ctx.cryptoCtx.evmAddress);
      const domain = makeDepositsDomain(ctx.chainConfig.evmChainId, ctx.cryptoConfig.depositsContractAddress);
      const signature = await signSetOperator(ctx.cryptoCtx.wallet, domain, {
        operator,
        nonce,
      });
      return { ok: true, signature, nonce: Number(nonce), buyer: ctx.cryptoCtx.evmAddress };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get('/api/emissions', async (_request, reply) => {
    const client = getEmissionsClient();
    if (!client && !emissionsGate) {
      return reply.status(503).send({ ok: false, error: 'Emissions contract not configured for this chain' });
    }
    try {
      if (emissionsGate) {
        const [currentEpoch, epochDuration, currentRate, genesis, halvingInterval] = await Promise.all([
          retryRead(() => emissionsGate.currentEpoch()), retryRead(() => emissionsGate.epochDuration()),
          retryRead(() => emissionsGate.currentEmissionRate()), retryRead(() => emissionsGate.genesis()),
          retryRead(() => emissionsGate.halvingInterval()),
        ]);
        const epochEmission = await retryRead(() => emissionsGate.getEpochEmission(currentEpoch));
        return { currentEpoch, epochDuration, currentRate: currentRate.toString(), epochEmission: epochEmission.toString(), genesis, halvingInterval };
      }
      const [info, genesis, halving] = await Promise.all([
        retryRead(() => client!.getEpochInfo()),
        retryRead(() => client!.getGenesis()),
        retryRead(() => client!.getHalvingInterval()),
      ]);
      const emission = await retryRead(() => client!.getEpochEmission(info.epoch));
      return {
        currentEpoch: info.epoch,
        epochDuration: info.epochDuration,
        currentRate: info.emission.toString(),
        epochEmission: emission.toString(),
        genesis,
        halvingInterval: halving,
      };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get('/api/emissions/pending', async (request, reply) => {
    // Legacy epochs always read the legacy V2 reward contract; the primary
    // emissions slot points to UsageAccounting after cutover.
    const legacyClient = getEmissionsClient();
    const usageAccounting = getUsageAccountingClient();
    const usageRewards = getUsageRewardsClient();
    const effectiveEpoch = ctx.chainConfig.recognizedUsage?.status === 'active'
      ? ctx.chainConfig.recognizedUsage.effectiveEpoch
      : null;
    const recognizedActive = effectiveEpoch !== null && usageAccounting !== null && usageRewards !== null;
    if (!legacyClient && !recognizedActive) {
      return reply.status(503).send({ ok: false, error: 'Emissions contract not configured for this chain' });
    }
    const query = request.query as { address?: string; epochs?: string } | undefined;
    const address = query?.address;
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return reply.status(400).send({ ok: false, error: 'Invalid address' });
    }
    const scanN = Math.min(Math.max(parseInt(query?.epochs ?? '10', 10) || 10, 1), 104);
    try {
      const current = recognizedActive
        ? await retryRead(() => usageAccounting.currentEpoch())
        : (await retryRead(() => legacyClient!.getEpochInfo())).epoch;
      const startEpoch = Math.max(0, current - (scanN - 1));
      const epochList = Array.from({ length: current - startEpoch + 1 }, (_, i) => startEpoch + i);

      const rows = await Promise.all(
        epochList.map(async (epoch) => {
          if (recognizedActive && epoch >= effectiveEpoch) {
            const [pending, buyerAmount] = await Promise.all([
              retryRead(() => usageAccounting.pendingEmissions(address, [epoch])),
              retryRead(() => usageRewards.pendingBuyerReward(address, epoch)),
            ]);
            return {
              epoch,
              protocol: 'recognized' as const,
              epochEmission: '0',
              params: null,
              seller: {
                amount: pending.seller.toString(),
                userPoints: '0',
                totalPoints: '0',
                claimed: false,
              },
              buyer: {
                amount: buyerAmount.toString(),
                userPoints: '0',
                totalPoints: '0',
                claimed: false,
              },
              isCurrent: epoch === current,
            };
          }

          if (!legacyClient) {
            return {
              epoch,
              protocol: 'legacy' as const,
              epochEmission: '0',
              params: null,
              seller: { amount: '0', userPoints: '0', totalPoints: '0', claimed: false },
              buyer: { amount: '0', userPoints: '0', totalPoints: '0', claimed: false },
              isCurrent: epoch === current,
            };
          }

          const pending = await retryRead(() => legacyClient.pendingEmissions(address, [epoch]));

          return {
            epoch,
            protocol: 'legacy' as const,
            epochEmission: '0',
            params: null,
            seller: {
              amount: pending.seller.toString(),
              userPoints: '0',
              totalPoints: '0',
              claimed: false,
            },
            buyer: {
              amount: pending.buyer.toString(),
              userPoints: '0',
              totalPoints: '0',
              claimed: false,
            },
            isCurrent: epoch === current,
          };
        }),
      );

      return { currentEpoch: current, rows };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get('/api/emissions/shares', async (_request, reply) => {
    const client = getEmissionsClient();
    if (!client) {
      return reply.status(503).send({ ok: false, error: 'Emissions contract not configured for this chain' });
    }
    try {
      return await retryRead(() => client.getShares());
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get('/api/emissions/transfers-enabled', async (_request, reply) => {
    const client = getAntsTokenClient();
    if (!client) {
      // When the ANTS token address isn't configured, treat as "not enabled yet"
      // — the UI uses this to decide whether to show the locked banner.
      return { enabled: false, configured: false };
    }
    try {
      const enabled = await client.transfersEnabled();
      return { enabled, configured: true };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
