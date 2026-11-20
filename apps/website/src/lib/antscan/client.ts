import {ANTS_TOKEN_ADDRESS} from '../ants.ts';
import {ENDPOINTS, type EmissionsResponse, type ListPricesResponse, type MarketplaceResponse, type TotalsResponse} from './api.ts';
import {selectMarket} from './lanes.ts';
import {selectAnts, selectTotals} from './selectors.ts';
import type {AntscanResources, ResourceKey} from './types.ts';

/** Reads each resource from the network (in the browser and in the build's snapshot plugin alike) and reduces it to the site's view. */

const DEAD = '0x000000000000000000000000000000000000dEaD';
const BALANCE_OF = '0x70a08231';

async function getJson<T>(url: string, signal: AbortSignal, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {...init, signal});
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`${what}: unexpected answer`);
  return value;
}

async function burnedHex(signal: AbortSignal): Promise<string> {
  const data = BALANCE_OF + DEAD.slice(2).toLowerCase().padStart(64, '0');
  const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{to: ANTS_TOKEN_ADDRESS, data}, 'latest']});
  const res = await getJson<{result?: string}>(ENDPOINTS.baseRpc, signal, {method: 'POST', headers: {'content-type': 'application/json'}, body});
  if (!res.result || res.result === '0x') throw new Error('balanceOf: empty eth_call result');
  return res.result;
}

export const LOADERS: {[K in ResourceKey]: (signal: AbortSignal) => Promise<AntscanResources[K]>} = {
  totals: async (signal) => required(selectTotals(await getJson<TotalsResponse>(ENDPOINTS.totals, signal)), 'totals'),
  market: async (signal) => {
    const [market, list] = await Promise.all([
      getJson<MarketplaceResponse>(ENDPOINTS.marketplace, signal),
      getJson<ListPricesResponse>(ENDPOINTS.listPrices, signal),
    ]);
    return required(selectMarket(market, list), 'marketplace');
  },
  ants: async (signal) => {
    const [emissions, burned] = await Promise.all([getJson<EmissionsResponse>(ENDPOINTS.emissions, signal), burnedHex(signal)]);
    return required(selectAnts(emissions, burned), 'emissions');
  },
};
