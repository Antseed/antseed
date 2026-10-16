import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { checkBuyerRoute, forgetBuyerRoute, readBuyerRoute, writeBuyerRoute } from './buyer-route.js';
import type { RoutingSelection } from '@antseed/node';

test('desktop route writes serialize rapid switches and connected-app updates preserve routers', async (context) => {
  let selection: RoutingSelection = { kind: 'model', model: null };
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.deepEqual(Object.keys(body), ['model', 'router']);
      if (body.router) await new Promise((resolve) => setTimeout(resolve, 20));
      selection = body.router ? { kind: 'router', ...body.router } : { kind: 'model', model: body.model };
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, ...(selection.kind === 'router' ? { model: null, router: { service: selection.service, options: selection.options } } : { model: selection.model, router: null }) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const router: RoutingSelection = { kind: 'router', service: { peerId: 'a'.repeat(40), provider: 'levanto', serviceId: 'route' }, options: { cost_quality_tradeoff: 5 } };
  forgetBuyerRoute();
  await Promise.all([
    writeBuyerRoute(port, { kind: 'model', model: 'first' }),
    writeBuyerRoute(port, router),
    writeBuyerRoute(port, { kind: 'model', model: 'stale' }, true),
  ]);
  assert.deepEqual(selection, router);
  await Promise.all([writeBuyerRoute(port, router), writeBuyerRoute(port, { kind: 'model', model: 'last' })]);
  assert.deepEqual(selection, { kind: 'model', model: 'last' });
});

async function routeServer(context: { after: (fn: () => void) => void }, initial: unknown) {
  const state = { body: initial, posts: 0 };
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') {
      state.posts++;
      for await (const _chunk of request) { /* drain */ }
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.method === 'POST' ? { ok: true } : state.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { if (server.listening) server.close(); });
  return { state, server, port: (server.address() as { port: number }).port };
}

const savedRouter = { service: { peerId: 'a'.repeat(40), provider: 'levanto', serviceId: 'route' }, options: { cost_quality_tradeoff: 3 }, allowedModels: [{ provider: 'openai', serviceId: 'model-a' }] };

test('desktop route reads return the saved router and fail quietly when the proxy is down', async (context) => {
  const { state, server, port } = await routeServer(context, { ok: true, model: null, router: savedRouter });
  assert.deepEqual(await readBuyerRoute(port), { ok: true, selection: { kind: 'router', ...savedRouter } });
  state.body = { ok: true, model: 'peer@model-b', router: null };
  assert.deepEqual(await readBuyerRoute(port), { ok: true, selection: { kind: 'model', model: 'peer@model-b' } });
  state.body = { ok: true, model: null, router: { ...savedRouter, preferences: { tradeoff: 9 } } };
  assert.deepEqual(await readBuyerRoute(port), { ok: false, error: 'Invalid buyer route' });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal((await readBuyerRoute(port)).ok, false);
});

test('external router changes are reported once and never echoed back to the proxy', async (context) => {
  forgetBuyerRoute();
  const { state, port } = await routeServer(context, { ok: true, model: null, router: savedRouter });
  assert.deepEqual(await checkBuyerRoute(port), { router: savedRouter });
  assert.equal(await checkBuyerRoute(port), null);
  assert.equal((await writeBuyerRoute(port, { kind: 'router', ...savedRouter })).ok, true);
  assert.equal(state.posts, 0);
  state.body = { ok: true, model: 'b'.repeat(40) + '@model-b', router: null };
  assert.deepEqual(await checkBuyerRoute(port), { peerId: 'b'.repeat(40), service: 'model-b' });
  state.body = { ok: true, model: 'model-c', router: null };
  assert.equal(await checkBuyerRoute(port), null);
});

test('desktop writes are not reported as external changes and an empty route reports nothing', async (context) => {
  forgetBuyerRoute();
  const { state, port } = await routeServer(context, { ok: true, model: null, router: null });
  assert.equal(await checkBuyerRoute(port), null);
  assert.equal((await writeBuyerRoute(port, { kind: 'router', ...savedRouter })).ok, true);
  assert.equal(state.posts, 1);
  state.body = { ok: true, model: null, router: savedRouter };
  assert.equal(await checkBuyerRoute(port), null);
});
