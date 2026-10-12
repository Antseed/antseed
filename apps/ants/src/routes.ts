import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZeroAddress } from 'ethers';
import { IndexerSyncingError } from './read-state.js';
import { networkSnapshot, networkLegacy } from './service/network.js';
import type { AntsContext } from './service/context.js';
import { JobRunner, describeError } from './jobs.js';
import type { ViewCache } from './view-cache.js';
import type { StepReporter } from './service/steps.js';
import { sellerModels } from './service/seller-models.js';
import {
  overview, positions, stake, move, split, merge, extend, maxLock, previewWithdraw, withdraw,
  rewards, claim, restake, stakeUsageRewards, compound, poolsView, singlePool, usage, emissions,
  verification, proofStatus, submitProof, seller, registerBinding, claimStarter,
} from './service/index.js';
import type {
  StakeRequest, MoveRequest, SplitRequest, MergeRequest, ExtendRequest, MaxLockRequest, WithdrawRequest,
  ClaimRequest, RestakeRequest, StakeUsageRequest, SubmitProofRequest, CompoundRequest,
} from './api-types.js';

export interface RouteContext {
  ctx: AntsContext;
  jobs: JobRunner;
  views: ViewCache;
  readOnly: boolean;
  dataDir: string | null;
  selectedAddress?: string;
  /** The buyer account this session started for; the local authorization flow only applies to it. */
  originBuyer: string;
  browserSigning?: import('./browser-signer.js').BrowserSigning;
  onAuthorize?: () => Promise<void>;
  rememberTransaction?: (hash: string) => Promise<void>;
}

export async function assertSelectedWallet(ctx: AntsContext, selected: string, wallet: string, scope: 'connection' | 'wallet' | 'buyer'): Promise<void> {
  if (scope !== 'buyer' && wallet.toLowerCase() === selected.toLowerCase()) return;
  if (scope === 'wallet') throw new Error(`Connect the selected account wallet ${selected} for seller and staking actions.`);
  const operator = await ctx.deposits()?.getOperator(selected);
  if (operator && operator !== ZeroAddress && wallet.toLowerCase() === operator.toLowerCase()) return;
  throw new Error(scope === 'buyer'
    ? `Connect the authorized wallet for buyer ${selected}. Current operator: ${operator && operator !== ZeroAddress ? operator : 'not configured; authorize a wallet first'}.`
    : `Wallet mismatch. Connect ${selected} for seller/staking actions${operator && operator !== ZeroAddress ? ` or authorized operator ${operator} for buyer actions` : '; no buyer operator is configured'}.`);
}

async function respond(reply: FastifyReply, read: () => Promise<unknown>): Promise<void> {
  try {
    reply.send({ ok: true, data: await read() });
  } catch (error) {
    if (error instanceof IndexerSyncingError) {
      reply.status(202).send({ ok: false, state: 'syncing' });
      return;
    }
    reply.status(400).send({ ok: false, error: describeError(error) });
  }
}

export function registerRoutes(app: FastifyInstance, context: RouteContext): void {
  const { ctx, jobs, views } = context;
  const cached = <T>(key: string, load: () => Promise<T>) => views.read(key, load);

  app.get('/api/config', async () => ({
    ok: true,
    data: { address: ctx.address, selectedAddress: context.selectedAddress, walletAddress: context.selectedAddress ? await ctx.signer?.getAddress() ?? null : ctx.address, chainId: ctx.chain.chainId, evmChainId: ctx.chain.evmChainId, walletRpcUrl: ctx.chain.evmChainId === 31337 && /^http:\/\/(127\.0\.0\.1|localhost):[0-9]+\/?$/.test(ctx.chain.rpcUrl) ? ctx.chain.rpcUrl : undefined, readOnly: !ctx.signer, browserWallet: !!context.browserSigning, buyerAddress: ctx.buyerAddress, canAuthorize: !!context.onAuthorize && ctx.buyerAddress.toLowerCase() === context.originBuyer.toLowerCase(), dataDir: context.dataDir },
  }));

  app.post('/api/wallet/authorize', (_request, reply) => respond(reply, async () => {
    if (!context.onAuthorize) throw new Error('Open the VPR wallet authorization setup to authorize a wallet.');
    if (ctx.buyerAddress.toLowerCase() !== context.originBuyer.toLowerCase()) throw new Error('The connected wallet is its own buyer account; the local authorization flow only applies to the originating buyer.');
    await context.onAuthorize(); return {};
  }));

  app.get('/api/overview', (_request, reply) => respond(reply, () => cached('overview', () => overview(ctx))));
  app.get('/api/positions', (_request, reply) => respond(reply, () => cached('positions', () => positions(ctx))));
  app.get('/api/rewards', (_request, reply) => respond(reply, () => cached('rewards', () => rewards(ctx))));
  app.get('/api/pools', (_request, reply) => respond(reply, () => views.read('pools', () => poolsView(ctx), 60_000,
    value => !value.walletSyncing && (value.source !== 'chain' || !value.sourceError))));
  app.get<{ Params: { address: string } }>('/api/sellers/:address/models', (request, reply) => respond(reply, () => views.read(`seller-models:${request.params.address.toLowerCase()}`, () => sellerModels(ctx.chain.explorerApiUrl, request.params.address), 60_000)));
  app.get<{ Params: { agentId: string } }>('/api/pools/:agentId', (request, reply) => respond(reply, () => views.read(`pool:${request.params.agentId}`, () => singlePool(ctx, Number(request.params.agentId)), undefined, value => !value.walletSyncing)));
  app.get<{ Querystring: { epochs?: string } }>('/api/usage', (request, reply) => respond(reply, () => cached(`usage:${request.query.epochs ?? ''}`, () => usage(ctx, { epochs: request.query.epochs ? Number(request.query.epochs) : undefined }))));
  app.get('/api/emissions', (_request, reply) => respond(reply, () => cached('emissions', () => emissions(ctx))));
  app.get('/api/network', (_request, reply) => respond(reply, () => networkSnapshot(ctx)));
  app.get('/api/network/legacy', (_request, reply) => respond(reply, () => views.read('network:legacy', () => networkLegacy(ctx), 300_000)));
  app.get<{ Querystring: { seller?: string } }>('/api/verification', (request, reply) => respond(reply, () => cached(`verification:${(request.query.seller ?? '').toLowerCase()}`, () => verification(ctx, request.query.seller || undefined))));
  app.get<{ Params: { proofId: string } }>('/api/verification/proofs/:proofId', (request, reply) => respond(reply, () => proofStatus(ctx, request.params.proofId)));
  app.get('/api/seller', (_request, reply) => respond(reply, () => cached('seller', () => seller(ctx))));
  app.post<{ Body: { positionIds: number[] } }>('/api/positions/withdraw/preview', (request, reply) => respond(reply, () => previewWithdraw(ctx, request.body?.positionIds ?? [])));

  // Browser sessions share one journal across wallets; show each wallet only its own actions.
  app.get('/api/jobs', async () => ({ ok: true, data: jobs.list(context.browserSigning ? ctx.address : undefined) }));
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.status(404).send({ ok: false, error: 'Unknown job' });
    return { ok: true, data: job };
  });

  const action = <Body>(path: string, kind: string, run: (body: Body, report: StepReporter) => Promise<unknown>) => {
    app.post(path, async (request, reply) => {
      if (!ctx.signer) return reply.status(403).send({ ok: false, error: 'The dashboard is running in read-only mode (no wallet available).' });
      try {
        const job = jobs.start(kind, async (report) => {
          ctx.invalidate();
          try {
            if (context.selectedAddress) {
              const body = (request.body ?? {}) as Partial<ClaimRequest & StakeUsageRequest>;
              const buyerOnly = (kind === 'claim' && body.scope === 'buyer') || (kind === 'stake-usage' && body.side === 'buyer');
              const wallet = await ctx.requireSigner().getAddress();
              await assertSelectedWallet(ctx, context.selectedAddress, wallet, buyerOnly ? 'buyer' : 'wallet');
              if (kind === 'claim' && body.scope !== 'wallet' && body.buckets?.includes('buyer')) {
                await assertSelectedWallet(ctx, context.selectedAddress, wallet, 'buyer');
              }
            }
            return await run((request.body ?? {}) as Body, async (label, hash) => {
              if (hash) ctx.invalidate();
              await report(label, hash);
              // Local position history is best-effort bookkeeping: an RPC hiccup or a
              // full disk must not abort a multi-transaction action whose step already confirmed.
              if (hash) {
                try { await context.rememberTransaction?.(hash); }
                catch (error) { console.warn(`[ants] could not record transaction ${hash}: ${describeError(error)}`); }
              }
            });
          } finally {
            ctx.invalidate();
          }
        }, ctx.address);
        return { ok: true, data: job };
      } catch (error) {
        return reply.status(409).send({ ok: false, error: describeError(error) });
      }
    });
  };

  action<StakeRequest>('/api/positions/stake', 'stake', (body, report) => stake(ctx, body, report));
  action<MoveRequest>('/api/positions/move', 'move', (body, report) => move(ctx, body, report));
  action<SplitRequest>('/api/positions/split', 'split', (body, report) => split(ctx, body, report));
  action<MergeRequest>('/api/positions/merge', 'merge', (body, report) => merge(ctx, body, report));
  action<ExtendRequest>('/api/positions/extend', 'extend', (body, report) => extend(ctx, body, report));
  action<MaxLockRequest>('/api/positions/max-lock', 'max-lock', (body, report) => maxLock(ctx, body, report));
  action<WithdrawRequest>('/api/positions/withdraw', 'withdraw', (body, report) => withdraw(ctx, body, report));
  action<ClaimRequest>('/api/rewards/claim', 'claim', (body, report) => claim(ctx, body, report));
  action<RestakeRequest>('/api/rewards/restake', 'restake', (body, report) => restake(ctx, body, report));
  action<StakeUsageRequest>('/api/rewards/stake-usage', 'stake-usage', (body, report) => stakeUsageRewards(ctx, body, report));
  action<CompoundRequest>('/api/rewards/compound', 'compound', (body, report) => compound(ctx, body, report));
  action<SubmitProofRequest>('/api/verification/submit', 'verify-submit', (body, report) => submitProof(ctx, body.artifact, report));
  action<{ agentId?: number }>('/api/seller/register', 'seller-register', (body, report) => registerBinding(ctx, body?.agentId, report));
  action<Record<string, never>>('/api/seller/claim-starter', 'claim-starter', (_body, report) => claimStarter(ctx, report));
}
