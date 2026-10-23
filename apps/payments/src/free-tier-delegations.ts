import { readFile, rename, writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { getAddress, isAddress } from 'ethers';
import {
  DEFAULT_FREE_TIER_DELEGATION_DAYS,
  FREE_TIER_DELEGATION_TYPES,
  MAX_FREE_TIER_DELEGATIONS,
  isFreeTierDelegationSigned,
  makeFreeTierDelegationDomain,
  type FreeTierDelegation,
} from '@antseed/node';

interface FreeTierDelegationRoutesContext {
  configPath: string;
  chainId: number;
  /** The buyer identity this page serves, or null when no identity is loaded. */
  buyerAddress: string | null;
}

/** The buyer's saved delegations from config.json (`buyer.freeTierDelegations`). */
export async function readFreeTierDelegations(configPath: string): Promise<FreeTierDelegation[]> {
  const config = await readConfig(configPath);
  const buyer = (config.buyer ?? {}) as Record<string, unknown>;
  return Array.isArray(buyer.freeTierDelegations) ? buyer.freeTierDelegations as FreeTierDelegation[] : [];
}

/**
 * Save `delegation`, replacing an earlier one from the same staker to the
 * same buyer. Other config keys are left untouched.
 */
export async function saveFreeTierDelegation(configPath: string, delegation: FreeTierDelegation): Promise<FreeTierDelegation[]> {
  const config = await readConfig(configPath);
  const buyer = (config.buyer ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(buyer.freeTierDelegations) ? buyer.freeTierDelegations as FreeTierDelegation[] : [];
  const sameBuyer = (entry: FreeTierDelegation) => entry.buyer.toLowerCase() === delegation.buyer.toLowerCase();
  const kept = existing.filter((entry) => !(sameBuyer(entry) && entry.staker.toLowerCase() === delegation.staker.toLowerCase()));
  if (kept.filter(sameBuyer).length >= MAX_FREE_TIER_DELEGATIONS) {
    throw new Error(`This buyer already has ${MAX_FREE_TIER_DELEGATIONS} stakers; remove one first.`);
  }
  const delegations = [...kept, delegation];
  config.buyer = { ...buyer, freeTierDelegations: delegations };
  const temp = `${configPath}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  await rename(temp, configPath);
  return delegations;
}

async function readConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * Routes for the "Share free tier" page: the staker's wallet signs a
 * delegation in the browser, and the server checks it and saves it for the
 * buyer node to send to sellers.
 */
export function registerFreeTierDelegationRoutes(fastify: FastifyInstance, ctx: FreeTierDelegationRoutesContext): void {
  fastify.get('/api/free-tier/delegations', async (_request, reply) => {
    if (!ctx.buyerAddress) return reply.status(503).send({ ok: false, error: 'Identity not configured' });
    const buyer = ctx.buyerAddress.toLowerCase();
    const delegations = (await readFreeTierDelegations(ctx.configPath))
      .filter((delegation) => delegation.buyer.toLowerCase() === buyer);
    return {
      ok: true,
      buyer: ctx.buyerAddress,
      chainId: ctx.chainId,
      defaultDays: DEFAULT_FREE_TIER_DELEGATION_DAYS,
      domain: makeFreeTierDelegationDomain(ctx.chainId),
      types: FREE_TIER_DELEGATION_TYPES,
      delegations,
    };
  });

  fastify.post('/api/free-tier/delegations', async (request, reply) => {
    if (!ctx.buyerAddress) return reply.status(503).send({ ok: false, error: 'Identity not configured' });
    const body = request.body as { staker?: unknown; expiresAt?: unknown; signature?: unknown } | null;
    const staker = typeof body?.staker === 'string' ? body.staker.trim() : '';
    const expiresAt = typeof body?.expiresAt === 'number' ? body.expiresAt : Number.NaN;
    const signature = typeof body?.signature === 'string' ? body.signature.trim() : '';
    if (!isAddress(staker)) return reply.status(400).send({ ok: false, error: 'Invalid staker address' });
    if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= Date.now()) {
      return reply.status(400).send({ ok: false, error: 'Expiry must be in the future' });
    }
    const delegation: FreeTierDelegation = {
      staker: getAddress(staker),
      buyer: getAddress(ctx.buyerAddress),
      expiresAt,
      signature,
    };
    if (!isFreeTierDelegationSigned(delegation, ctx.chainId)) {
      return reply.status(400).send({ ok: false, error: 'The signature does not match the staker wallet' });
    }
    try {
      await saveFreeTierDelegation(ctx.configPath, delegation);
      return { ok: true, delegation };
    } catch (err) {
      return reply.status(409).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
