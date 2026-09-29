import { startPaymentsPortal, paymentsServer, getPaymentsPortalToken, PAYMENTS_PORT } from '../payments/portal.js';
import { app, shell } from 'electron';
import path from 'node:path';
import { resolveStakingChain } from './configuration.js';
import { readConfig } from '../runtime/config-io.js';
import { ensureSecureIdentity, getSecureIdentity } from '../identity.js';
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
import { getMainWindow } from '../ui/window.js';
import { invalidateCreditsCache } from '../payments/credits.js';
import { createStakingWindowSession } from './window.js';
import { StakingSessionManager } from './session.js';

export const stakingSessions = new StakingSessionManager(async () => {
  await ensureSecureIdentity();
  const identity = getSecureIdentity();
  if (!identity) throw new Error('Your VPR wallet is unavailable. Restore access to your wallet before opening Staking.');
  // Use VPR's selected config, without the CLI-only environment RPC override.
  const chain = resolveStakingChain(await readConfig(ACTIVE_CONFIG_PATH));
  return createStakingWindowSession({
    dataDir: path.join(app.getPath('userData'), 'staking'),
    chain,
    browserWallet: true,
    onAuthorize: async () => {
      await startPaymentsPortal();
      if (!paymentsServer) throw new Error('Could not start the wallet authorization flow.');
      const params = new URLSearchParams({ token: getPaymentsPortalToken(), page: 'pay', action: 'authorize' });
      await shell.openExternal(`http://127.0.0.1:${PAYMENTS_PORT}?${params}`);
    },
    address: identity.wallet.address,
    onActionFinished: () => {
      invalidateCreditsCache();
      getMainWindow()?.webContents.send('payments:completed');
    },
  }, getMainWindow);
});
