import { expect, it } from 'vitest';
import type { ChatModel } from '../../types/bridge';
import { modelsForPrivacy } from './usePrivateMode';

function row(id: string, extra: Partial<ChatModel> = {}): ChatModel {
  return {
    id, label: id, type: 'text', protocol: 'openai-chat-completions', supportsImages: false, sellers: 1, free: false,
    minImageUsd: null, freeSellerId: null, freeForStakers: false, tee: false, toolUse: false, reasoning: false,
    inputUsdPerMillion: null, outputUsdPerMillion: null, ...extra,
  };
}

it('Private keeps TEE models and the routers the gateway listed under its policy', () => {
  const tee = row('tee-model', { tee: true });
  const plain = row('plain-model');
  const router = row('<peerId>@example-router', { router: { sellerName: null, priceUsdPerRequest: 0, models: 3 } });
  // Home and Chat both narrow their picker rows here.
  expect(modelsForPrivacy([tee, plain, router], true)).toEqual([tee, router]);
  expect(modelsForPrivacy([tee, plain, router], false)).toEqual([tee, plain, router]);
});
