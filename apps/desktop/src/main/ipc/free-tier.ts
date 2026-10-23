import { ipcMain } from 'electron';
import { acceptFreeTierDelegationCode, withFreeTierDelegation, type FreeTierDelegation } from '@antseed/node';
import { ensureSecureIdentity, getSecureIdentity } from '../identity.js';
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
import { mergeConfig, readConfig } from '../runtime/config-io.js';
import { resolveStakingChain } from '../staking/configuration.js';
import { getMainWindow } from '../ui/window.js';

interface FreeTierSharing {
  buyer: string;
  stakers: Array<{ staker: string; expiresAt: number; expired: boolean }>;
}

async function buyerAddress(): Promise<string> {
  await ensureSecureIdentity();
  const identity = getSecureIdentity();
  if (!identity) throw new Error('Your VPR wallet is unavailable.');
  return identity.wallet.address;
}

function savedDelegations(config: Record<string, unknown>): FreeTierDelegation[] {
  const buyer = (config.buyer ?? {}) as Record<string, unknown>;
  return Array.isArray(buyer.freeTierDelegations) ? buyer.freeTierDelegations as FreeTierDelegation[] : [];
}

function sharingFor(buyer: string, delegations: readonly FreeTierDelegation[]): FreeTierSharing {
  const now = Date.now();
  return {
    buyer,
    stakers: delegations
      .filter((delegation) => delegation.buyer.toLowerCase() === buyer.toLowerCase())
      .map((delegation) => ({ staker: delegation.staker, expiresAt: delegation.expiresAt, expired: delegation.expiresAt * 1000 <= now })),
  };
}

let pendingMutation: Promise<unknown> = Promise.resolve();

/** Run each read-modify-write of the saved delegations after the previous one finishes. */
function serialized<T>(mutation: () => Promise<T>): Promise<T> {
  const run = pendingMutation.then(mutation, mutation);
  pendingMutation = run.catch(() => undefined);
  return run;
}

/**
 * Staked free tier: stakers share their seller-pool stake with this buyer by
 * giving it a code from the staking dashboard. Codes are saved in config.json
 * (`buyer.freeTierDelegations`); the running buyer reloads them within a minute.
 */
export function registerFreeTierIpc(): void {
  const handle = (channel: string, run: (arg: unknown) => Promise<FreeTierSharing>) => {
    ipcMain.handle(channel, async (event, arg: unknown) => {
      if (event.sender !== getMainWindow()?.webContents) return { ok: false, error: 'Free tier can only be managed from the VPR main window.' };
      try {
        return { ok: true, data: await run(arg) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  };

  handle('freeTier:list', async () => sharingFor(await buyerAddress(), savedDelegations(await readConfig(ACTIVE_CONFIG_PATH))));

  handle('freeTier:add', async (code) => {
    if (typeof code !== 'string') throw new Error('Paste a free-tier code.');
    const buyer = await buyerAddress();
    return serialized(async () => {
      const config = await readConfig(ACTIVE_CONFIG_PATH);
      const delegation = acceptFreeTierDelegationCode(code, buyer, resolveStakingChain(config).evmChainId);
      const delegations = withFreeTierDelegation(savedDelegations(config), delegation);
      await mergeConfig({ buyer: { freeTierDelegations: delegations } }, ACTIVE_CONFIG_PATH);
      return sharingFor(buyer, delegations);
    });
  });

  handle('freeTier:remove', async (staker) => {
    if (typeof staker !== 'string') throw new Error('Choose a staker to remove.');
    const buyer = await buyerAddress();
    return serialized(async () => {
      const delegations = savedDelegations(await readConfig(ACTIVE_CONFIG_PATH)).filter((delegation) =>
        !(delegation.buyer.toLowerCase() === buyer.toLowerCase() && delegation.staker.toLowerCase() === staker.toLowerCase()));
      await mergeConfig({ buyer: { freeTierDelegations: delegations } }, ACTIVE_CONFIG_PATH);
      return sharingFor(buyer, delegations);
    });
  });
}
