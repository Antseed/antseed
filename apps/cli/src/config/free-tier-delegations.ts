import type { FreeTierDelegation } from '@antseed/node';
import { patchConfigFile } from '../gateway/services/settings.js';

/**
 * Rewrite only `buyer.freeTierDelegations` in the raw config file, under the
 * config lock, so concurrent edits keep each other's changes and every other
 * setting stays exactly as written.
 */
export function updateFreeTierDelegations(
  configPath: string,
  mutate: (current: FreeTierDelegation[]) => FreeTierDelegation[],
): Promise<void> {
  return patchConfigFile(configPath, (config) => {
    const buyer = (config['buyer'] && typeof config['buyer'] === 'object' ? config['buyer'] : {}) as Record<string, unknown>;
    const current = Array.isArray(buyer['freeTierDelegations']) ? buyer['freeTierDelegations'] as FreeTierDelegation[] : [];
    config['buyer'] = { ...buyer, freeTierDelegations: mutate(current) };
  });
}
