/**
 * The Rewards summary: $ANTS the gateway's paying wallet earned from usage.
 * The gateway (local or remote) reads it on its own chain
 * (`GET /v1/key/rewards`); claiming needs the wallet's operator signature, so
 * it happens in the Gateway Console's Rewards page.
 */
import type { GatewayRewardsSummary } from '../../shared/gateway-types.js';

export type { GatewayRewardsSummary };

/**
 * A gateway that predates `GET /v1/key/rewards`: no amount is read here (this
 * app's chain may not be the gateway's), so `available` is false and the
 * gateway's own Rewards page has the figures.
 */
export function unreadRewardsSummary(address: string): GatewayRewardsSummary {
  return { available: false, address, pendingAnts: '0', currentEpoch: null, transfersEnabled: false, remoteChainUnverified: true };
}
