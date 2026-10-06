import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { buyerRouteSelection, writeBuyerRoute } from './buyer-route.js';
import type { RoutingSelection } from '@antseed/node';

test('buyer route reads prefer explicit models and reject obsolete router settings', () => {
  const router = { service: { peerId: 'a'.repeat(40), provider: 'router', serviceId: 'rank' }, costQualityTradeoff: 0 };
  assert.deepEqual(buyerRouteSelection({ model: 'explicit', router }), { kind: 'model', model: 'explicit' });
  assert.deepEqual(buyerRouteSelection({ model: null, router }), { kind: 'router', ...router });
  assert.throws(() => buyerRouteSelection({ router: { ...router, preferences: { tradeoff: '9' } } }), /Invalid buyer route/);
});

test('desktop route writes serialize rapid switches and connected-app updates preserve routers', async (context) => {
  let selection: RoutingSelection = { kind: 'model', model: null };
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.deepEqual(Object.keys(body), ['model', 'router']);
      if (body.router) await new Promise((resolve) => setTimeout(resolve, 20));
      selection = buyerRouteSelection(body);
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, ...(selection.kind === 'router' ? { model: null, router: { service: selection.service, costQualityTradeoff: selection.costQualityTradeoff } } : { model: selection.model, router: null }) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const router: RoutingSelection = { kind: 'router', service: { peerId: 'a'.repeat(40), provider: 'levanto', serviceId: 'route' }, costQualityTradeoff: 5 };
  await Promise.all([
    writeBuyerRoute(port, { kind: 'model', model: 'first' }),
    writeBuyerRoute(port, router),
    writeBuyerRoute(port, { kind: 'model', model: 'stale' }, true),
  ]);
  assert.deepEqual(selection, router);
  await Promise.all([writeBuyerRoute(port, router), writeBuyerRoute(port, { kind: 'model', model: 'last' })]);
  assert.deepEqual(selection, { kind: 'model', model: 'last' });
});
