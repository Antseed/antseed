import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGatewayRouters } from './routers.js';

test('parseGatewayRouters makes one row per seller offering a router, sent to by its peer@service model', () => {
  const rows = parseGatewayRouters({
    object: 'list',
    data: [{
      id: 'example-router',
      name: 'Example Router',
      type: 'router',
      peers: [
        { peerId: '<peerA>', displayName: 'Example Seller', model: '<peerA>@example-router', priceUsdPerRequest: 0.0001, models: ['model-a', 'model-b'] },
        { peerId: '<peerB>', model: '<peerB>@example-router', priceUsdPerRequest: 0, models: null },
        { peerId: '<peerC>' },
      ],
    }],
  });
  assert.deepEqual(rows.map((row) => [row.id, row.label, row.type, row.protocol, row.router]), [
    ['<peerA>@example-router', 'Example Router', 'text', 'openai-chat-completions', { sellerName: 'Example Seller', priceUsdPerRequest: 0.0001, models: 2 }],
    ['<peerB>@example-router', 'Example Router', 'text', 'openai-chat-completions', { sellerName: null, priceUsdPerRequest: 0, models: null }],
  ]);
  // Only the pick is priced: a router is never listed as a free model.
  assert.ok(rows.every((row) => !row.free));
});

test('parseGatewayRouters has no rows for an answer that is not a list', () => {
  assert.deepEqual(parseGatewayRouters(null), []);
  assert.deepEqual(parseGatewayRouters({ data: 'nope' }), []);
});
