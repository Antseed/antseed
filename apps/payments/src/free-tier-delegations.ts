import { randomUUID } from 'node:crypto';
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { getAddress, isAddress } from 'ethers';
import {
  DEFAULT_FREE_TIER_DELEGATION_DAYS,
  FREE_TIER_DELEGATION_TYPES,
  isFreeTierDelegationSigned,
  makeFreeTierDelegationDomain,
  withFreeTierDelegation,
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

const pendingSaves = new Map<string, Promise<unknown>>();

/**
 * Save `delegation`, replacing an earlier one from the same staker to the
 * same buyer. Other config keys are left untouched. Saves to one config file
 * run one at a time, so concurrent saves keep each other's delegations; a
 * symlinked config is updated at its target and keeps its permissions.
 */
export async function saveFreeTierDelegation(configPath: string, delegation: FreeTierDelegation): Promise<FreeTierDelegation[]> {
  const target = await realTarget(configPath);
  const save = async () => {
    const config = await readConfig(target);
    const buyer = (config.buyer ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(buyer.freeTierDelegations) ? buyer.freeTierDelegations as FreeTierDelegation[] : [];
    const delegations = withFreeTierDelegation(existing, delegation);
    config.buyer = { ...buyer, freeTierDelegations: delegations };
    const mode = await fileMode(target) ?? 0o600;
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf-8', mode });
      await chmod(temp, mode);
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    return delegations;
  };
  const previous = pendingSaves.get(target) ?? Promise.resolve();
  const run = previous.then(save, save);
  const settled = run.catch(() => undefined);
  pendingSaves.set(target, settled);
  void settled.then(() => {
    if (pendingSaves.get(target) === settled) pendingSaves.delete(target);
  });
  return run;
}

/** The file a config path points to, following symlinks; the path itself when it does not exist yet. */
async function realTarget(configPath: string): Promise<string> {
  try {
    return await realpath(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return configPath;
    throw err;
  }
}

async function fileMode(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
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
