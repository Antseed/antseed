import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { writeBuyerRoute } from './buyer-route.js';
import type { RoutingSelection } from '@antseed/node';

test('desktop route writes serialize rapid switches and connected-app updates preserve routers', async (context) => {
  let selection: RoutingSelection = { kind: 'model', model: null };
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.deepEqual(Object.keys(body), ['selection']);
      if (body.selection.kind === 'router') await new Promise((resolve) => setTimeout(resolve, 20));
      selection = body.selection;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, selection }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const router: RoutingSelection = { kind: 'router', service: { peerId: 'a'.repeat(40), provider: 'levanto', serviceId: 'route' }, preferences: { cqt: '5' } };
  await Promise.all([
    writeBuyerRoute(port, { kind: 'model', model: 'first' }),
    writeBuyerRoute(port, router),
    writeBuyerRoute(port, { kind: 'model', model: 'stale' }, true),
  ]);
  assert.deepEqual(selection, router);
  await Promise.all([writeBuyerRoute(port, router), writeBuyerRoute(port, { kind: 'model', model: 'last' })]);
  assert.deepEqual(selection, { kind: 'model', model: 'last' });
});
