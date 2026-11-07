import { describe, expect, it } from 'vitest';
import plugin from './index.js';

const base = { ANTSEED_ALLOWED_SERVICES: 'qwen,llama', COLONY_POOL_SELLER_ADDRESS: `0x${'aa'.repeat(20)}` };

describe('colony pool configuration', () => {
  it('refuses to sell a service for free, since its workers are paid from what buyers pay', () => {
    expect(() => plugin.createProvider(base)).toThrow(/can't sell qwen, llama for free/);
    // A paid default with one service priced at zero still leaves that one free.
    expect(() => plugin.createProvider({
      ...base,
      ANTSEED_OUTPUT_USD_PER_MILLION: '1',
      ANTSEED_SERVICE_PRICING_JSON: JSON.stringify({ llama: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } }),
    })).toThrow(/can't sell llama for free/);
  });

  it('refuses a protocol fee that is not a whole number of basis points up to 10000', () => {
    for (const fee of ['10001', '1.5']) {
      expect(() => plugin.createProvider({ ...base, ANTSEED_OUTPUT_USD_PER_MILLION: '1', COLONY_POOL_PROTOCOL_FEE_BPS: fee }))
        .toThrow(/COLONY_POOL_PROTOCOL_FEE_BPS must be a whole number from 0 to 10000/);
    }
  });
});
