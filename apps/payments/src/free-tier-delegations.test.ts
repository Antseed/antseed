import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { FREE_TIER_DELEGATION_TYPES, freeTierDelegationMessage, makeFreeTierDelegationDomain } from '@antseed/node';
import { registerFreeTierDelegationRoutes } from './free-tier-delegations.js';

const CHAIN_ID = 8453;
const BUYER = Wallet.createRandom().address;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-free-tier-'));
  dirs.push(dir);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ buyer: { proxyPort: 8377 }, seller: { freeTier: { maxRequestsPerAddress: 5 } } }));
  const app = Fastify();
  registerFreeTierDelegationRoutes(app, { configPath, chainId: CHAIN_ID, buyerAddress: BUYER });
  return { app, configPath };
}

async function signed(staker: Pick<Wallet, 'address' | 'signTypedData'>, expiresAt: number) {
  const signature = await staker.signTypedData(
    makeFreeTierDelegationDomain(CHAIN_ID),
    FREE_TIER_DELEGATION_TYPES,
    freeTierDelegationMessage({ staker: staker.address, buyer: BUYER, expiresAt }),
  );
  return { staker: staker.address, expiresAt, signature };
}

describe('free-tier delegation routes', () => {
  it('saves a delegation signed by the staker, keeping the rest of the config', async () => {
    const { app, configPath } = await setup();
    const staker = Wallet.createRandom();
    const expiresAt = Math.floor(Date.now() / 1000) + 86_400;
    const response = await app.inject({ method: 'POST', url: '/api/free-tier/delegations', payload: await signed(staker, expiresAt) });
    expect(response.statusCode).toBe(200);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.buyer.proxyPort).toBe(8377);
    expect(config.seller.freeTier.maxRequestsPerAddress).toBe(5);
    expect(config.buyer.freeTierDelegations).toEqual([expect.objectContaining({ staker: staker.address, buyer: BUYER, expiresAt })]);

    // Signing again replaces the earlier delegation instead of adding another.
    await app.inject({ method: 'POST', url: '/api/free-tier/delegations', payload: await signed(staker, expiresAt + 10) });
    const listed = (await app.inject({ method: 'GET', url: '/api/free-tier/delegations' })).json();
    expect(listed.delegations).toHaveLength(1);
    expect(listed.delegations[0].expiresAt).toBe(expiresAt + 10);
  });

  it('rejects a signature from a different wallet and expired delegations', async () => {
    const { app } = await setup();
    const staker = Wallet.createRandom();
    const forged = { ...(await signed(Wallet.createRandom(), Math.floor(Date.now() / 1000) + 60)), staker: staker.address };
    expect((await app.inject({ method: 'POST', url: '/api/free-tier/delegations', payload: forged })).statusCode).toBe(400);
    const expired = await signed(staker, Math.floor(Date.now() / 1000) - 1);
    expect((await app.inject({ method: 'POST', url: '/api/free-tier/delegations', payload: expired })).statusCode).toBe(400);
  });
});
