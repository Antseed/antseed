import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { AntseedNode } from '@antseed/node';
import { loadRouterPlugin } from '../../apps/cli/src/plugins/loader.js';
import { buildCliChildEnv } from '../../apps/desktop/src/main/runtime/process-manager.js';
import { BuyerProxy } from '../../apps/cli/src/proxy/buyer-proxy.js';
import { buyerRouteSelection, writeBuyerRoute } from '../../apps/desktop/src/main/chat/buyer-route.js';
import { createLocalBootstrap } from './helpers/local-bootstrap.js';
import { FakeLevantoProvider, FakeRoutedInferenceProvider } from './helpers/fake-levanto.js';
import { createLevantoChain } from './helpers/levanto-chain.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeout = 25_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for test condition');
}

describe('VPR → buyer HTTP → real P2P → fake Levanto → inference', () => {
  let directory: string;
  let bootstrap: Awaited<ReturnType<typeof createLocalBootstrap>>;
  const nodes: AntseedNode[] = [];
  const paid = process.env.ANTSEED_LEVANTO_CHAIN === '1';
  const routing = new FakeLevantoProvider(paid ? 0.001 : 0);
  const inference = new FakeRoutedInferenceProvider();
  let chain: Awaited<ReturnType<typeof createLevantoChain>> | undefined;
  let routingSellerAddress: string;
  let inferenceSellerAddress: string;
  let buyerAddress: string;
  let proxy: BuyerProxy;
  let port: number;
  let base: string;
  let service: { peerId: string; provider: string; serviceId: string };
  let inferencePeer: string;
  let sequence = 0;

  beforeEach(() => {
    const seller = nodes[1] as unknown as { _sellerHandler: { _attestRateWindows: Map<string, unknown> } };
    seller._sellerHandler._attestRateWindows.clear();
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'antseed-levanto-vpr-'));
    if (paid) chain = await createLevantoChain(await freePort());
    if (paid) inference.pricing.defaults = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
    bootstrap = await createLocalBootstrap();
    for (const [index, provider] of [inference, routing].entries()) {
      const dataDir = join(directory, `seller-${index}`);
      if (chain) {
        const address = await chain.fund(dataDir, true);
        if (index === 1) routingSellerAddress = address;
        else inferenceSellerAddress = address;
      }
      const seller = new AntseedNode({ role: 'seller', dataDir, dhtPort: 0, signalingPort: 0, payments: chain?.payments,
        ...(index === 1 ? { displayName: 'Levanto' } : {}),
        bootstrapNodes: bootstrap.bootstrapConfig, allowPrivateIPs: true, noOfficialBootstrap: true });
      nodes.push(seller);
      seller.registerProvider(provider);
      await seller.start();
    }
    inferencePeer = nodes[0]!.peerId;
    routing.candidates = [{ model: 'model-a', peer: inferencePeer }, { model: 'model-b', peer: inferencePeer }];
    service = { peerId: nodes[1]!.peerId, provider: routing.name, serviceId: routing.services[0]! };
    if (chain) buyerAddress = await chain.fund(join(directory, 'buyer'), false);
    const buyer = new AntseedNode({ role: 'buyer', dataDir: join(directory, 'buyer'), dhtPort: 0, payments: chain?.payments,
      bootstrapNodes: bootstrap.bootstrapConfig, allowPrivateIPs: true, noOfficialBootstrap: true });
    nodes.push(buyer);
    const previousRouterPath = process.env['ANTSEED_DEV_ROUTER_LOCAL_PATH'];
    try {
      process.env['ANTSEED_DEV_ROUTER_LOCAL_PATH'] = buildCliChildEnv({}, true)['ANTSEED_DEV_ROUTER_LOCAL_PATH'];
      const localPlugin = await loadRouterPlugin('local');
      buyer.setRouter(await localPlugin.createRouter({ ANTSEED_MIN_REPUTATION: '0', ANTSEED_MAX_FAILURES: '100' }));
    } finally {
      if (previousRouterPath === undefined) delete process.env['ANTSEED_DEV_ROUTER_LOCAL_PATH'];
      else process.env['ANTSEED_DEV_ROUTER_LOCAL_PATH'] = previousRouterPath;
    }
    await buyer.start();
    if (paid) expect(buyer.buyerPaymentManager, 'Paid E2E requires initialized buyer payments; check chain configuration and Node-native SQLite').toBeTruthy();
    await waitUntil(async () => (await buyer.discoverPeers()).length === 2);
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proxy = new BuyerProxy({ node: buyer, port, dataDir: join(directory, 'buyer'), peerCacheTtlMs: 1000 });
    await proxy.start();
    await waitUntil(async () => (await (await fetch(`${base}/_antseed/routing-services`)).json()).services.length === 1);
  }, 180_000);

  afterAll(async () => {
    await proxy?.stop();
    for (const node of nodes.reverse()) await node.stop();
    await bootstrap?.stop();
    await chain?.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  const chooseRouter = (costQualityTradeoff = 5) => writeBuyerRoute(port, { kind: 'router', service, costQualityTradeoff });
  const readRoute = async () => {
    const selection = buyerRouteSelection(await (await fetch(`${base}/_antseed/route`)).json());
    return selection.kind === 'router' ? selection : { ...selection, allowedModels: undefined, costQualityTradeoff: undefined };
  };
  const send = async (model = 'antseed', headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: `Hello ${++sequence}` }], stream: false }) });
    const body = await response.json();
    if (!response.ok) console.error('Fake Levanto response', routing.mode, response.status, JSON.stringify(body));
    return { status: response.status, body };
  };

  it('discovers exact completed-request offers outside the model catalog', async () => {
    const offers = await (await fetch(`${base}/_antseed/routing-services`)).json();
    expect(offers.services).toEqual([expect.objectContaining({ ...service, priceMicroUsdc: paid ? '1000' : '0',
      catalog: { models: routing.models.map(serviceId => ({ provider: inference.name, serviceId })) }, catalogExpiresAt: expect.any(Number) })]);
    const catalog = await (await fetch(`${base}/v1/models`)).json();
    expect(catalog.data.map((entry: { id: string }) => entry.id)).not.toContain('levanto-route');
    const before = routing.modelsRequests;
    await fetch(`${base}/_antseed/routing-services`);
    expect(routing.modelsRequests).toBe(before);
  });

  it('switches model → router → different recommendation → model', async () => {
    expect((await writeBuyerRoute(port, { kind: 'model', model: 'model-a' })).ok).toBe(true);
    expect((await send()).body.model).toBe('model-a');
    const before = routing.requests.length;
    expect((await chooseRouter(9)).ok).toBe(true);
    expect((await send()).body.model).toBe('model-a');
    expect(routing.requests.at(-1)?.routing).toMatchObject({ cost_quality_tradeoff: 9 });
    routing.mode = 'second';
    expect((await send('antseed')).body.model).toBe('model-b');
    expect(routing.requests.length).toBe(before + 2);
    await writeBuyerRoute(port, { kind: 'model', model: 'model-a' });
    expect((await send()).body.model).toBe('model-a');
    expect(routing.requests.length).toBe(before + 2);
  });

  it.skipIf(paid)('enforces exact model allowlists before inference, including empty lists and mixed rankings', async () => {
    const allowedModels = [{ provider: inference.name, serviceId: 'model-a' }];
    expect((await writeBuyerRoute(port, { kind: 'router', service, costQualityTradeoff: 5, allowedModels })).ok).toBe(true);
    expect((await readRoute()).allowedModels).toEqual(allowedModels);
    routing.mode = 'second';
    const before = inference.requests.length;
    expect((await send()).status).toBeGreaterThanOrEqual(400);
    expect(inference.requests.length).toBe(before);
    routing.mode = 'fallback';
    expect((await send()).body.model).toBe('model-a');
    expect(routing.requests.at(-1)).toMatchObject({ routing: { candidates: [{ id: inference.name + ':model-a@' + inferencePeer, model: 'model-a' }] } });
    expect((await send('model-b')).body.model).toBe('model-b');
    const beforeFallback = inference.requests.length;
    inference.failingModels.add('model-a');
    try {
      expect((await send()).status).toBeGreaterThanOrEqual(400);
      expect(inference.requests.slice(beforeFallback).map(request => request.model)).toEqual(['model-a']);
    } finally { inference.failingModels.clear(); }
    const routingBefore = routing.requests.length;
    await writeBuyerRoute(port, { kind: 'router', service, costQualityTradeoff: 5, allowedModels: [] });
    expect((await send()).status).toBeGreaterThanOrEqual(400);
    expect(routing.requests.length).toBe(routingBefore);
    await chooseRouter();
    routing.mode = 'first';
  });

  it('preserves router mode on connected-app sync, while explicit models and pins override', async () => {
    routing.mode = 'second';
    await chooseRouter();
    await writeBuyerRoute(port, { kind: 'model', model: `${inferencePeer}@model-a` }, true);
    expect((await readRoute()).kind).toBe('router');
    expect((await send('model-a', { 'x-antseed-system-proxy-source': 'test', 'x-antseed-system-routed': '1' })).body.model).toBe('model-b');
    const count = routing.requests.length;
    expect((await send('model-a')).body.model).toBe('model-a');
    expect((await send(`${inferencePeer}@model-a`)).body.model).toBe('model-a');
    expect(routing.requests.length).toBe(count);
  });

  it('respects a conversation pin until the user explicitly clears it', async () => {
    routing.mode = 'second';
    await chooseRouter();
    const headers = { 'x-vpr-session-id': 'pinned-chat' };
    expect((await send(`${inferencePeer}@model-a`, headers)).body.model).toBe('model-a');
    expect((await send('antseed', headers)).body.model).toBe('model-a');
    await fetch(`${base}/_antseed/conversations/update`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'vpr:pinned-chat', pinnedModel: null, peerSource: 'auto' }) });
    expect((await send('antseed', headers)).body.model).toBe('model-b');
  });

  it('streams routed messages through both supported chat formats', async () => {
    routing.mode = 'second';
    await chooseRouter();
    for (const path of ['/v1/messages', '/v1/chat/completions']) {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'antseed', stream: true, max_tokens: 100, messages: [{ role: 'user', content: `Stream ${++sequence}` }] }) });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(await response.text()).toContain('Reply from model-b');
    }
  });

  it('routes Responses input from connected apps through normal protocol adaptation', async () => {
    routing.mode = 'second';
    await chooseRouter();
    for (const input of ['Responses input', [{ role: 'user', content: [{ type: 'input_text', text: 'Structured Responses input' }] }]]) {
      const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-antseed-system-proxy-source': 'codex', 'x-antseed-system-routed': '1',
      }, body: JSON.stringify({ model: 'connect-time-model', input, stream: false }) });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(JSON.stringify(body)).toContain('Reply from model-b');
    }
  });

  it.skipIf(paid)('uses ranked fallback when the first recommended model fails', async () => {
    routing.mode = 'fallback';
    inference.failingModels.add('model-a');
    try {
      await chooseRouter();
      expect((await send()).body.model).toBe('model-b');
    } finally { inference.failingModels.clear(); }
  });

  it.skipIf(paid)('cancels a pending recommendation without dispatching inference', async () => {
    routing.mode = 'delayed';
    await chooseRouter();
    const controller = new AbortController();
    const before = routing.requests.length;
    const inferenceCount = inference.requests.length;
    const request = fetch(`${base}/v1/chat/completions`, { method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'antseed', messages: [{ role: 'user', content: `Cancel ${++sequence}` }] }),
    }).then(() => false, (error: Error) => error.name === 'AbortError');
    await waitUntil(() => routing.requests.length === before + 1);
    controller.abort();
    expect(await request).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(inference.requests.length).toBe(inferenceCount);
  });

  it.skipIf(paid).each(['invalid-json', 'empty', 'foreign-peer', 'wrong-model', 'wrong-provider', 'unavailable', 'cannot-rank'] as const)('fails closed for %s without inference or unconstrained retries', async (mode) => {
    routing.mode = mode;
    await chooseRouter();
    const count = inference.requests.length;
    const routingCount = routing.requests.length;
    const result = await send();
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(inference.requests.length).toBe(count);
    expect(routing.requests.length).toBe(routingCount + (mode === 'cannot-rank' ? 2 : 1));
    expect(routing.requests.at(-1)?.routing).toBeDefined();
  });

  it.skipIf(paid)('filters unknown candidates while accepting an allowed recommendation', async () => {
    routing.mode = 'ignore-constraints';
    await writeBuyerRoute(port, { kind: 'router', service, costQualityTradeoff: 5,
      allowedModels: [{ provider: inference.name, serviceId: 'model-a' }] });
    const count = inference.requests.length;
    expect((await send()).status).toBe(200);
    expect(inference.requests.length).toBe(count + 1);
    routing.mode = 'first';
    await chooseRouter();
  });

  it('keeps an in-flight routing purchase stable while changing the default', async () => {
    routing.mode = 'delayed';
    await chooseRouter();
    const count = routing.requests.length;
    const pending = send();
    await waitUntil(() => routing.requests.length === count + 1);
    await writeBuyerRoute(port, { kind: 'model', model: 'model-b' });
    expect((await pending).body.model).toBe('model-a');
    expect((await send()).body.model).toBe('model-b');
  });

  it('rejects invalid IRP tradeoffs and persists selection across proxy restart', async () => {
    expect((await chooseRouter(11)).ok).toBe(false);
    routing.mode = 'first';
    const selection = { kind: 'router' as const, service, costQualityTradeoff: 7,
      allowedModels: [{ provider: inference.name, serviceId: 'model-a' }] };
    expect((await writeBuyerRoute(port, selection)).ok).toBe(true);
    await proxy.stop();
    proxy = new BuyerProxy({ node: nodes[2]!, port, dataDir: join(directory, 'buyer') });
    await proxy.start();
    expect((await readRoute())).toEqual(selection);
    expect((await send()).body.model).toBe('model-a');
  });

  it.skipIf(process.env.ANTSEED_LEVANTO_BROWSER !== '1')('drives the real VPR picker and chat controller in Chromium', async () => {
    const { createServer: createVite } = await import('vite');
    const { chromium } = await import('playwright');
    const vite = await createVite({ configFile: false, root: resolve(import.meta.dirname, '../../apps/desktop'),
      css: { modules: { localsConvention: 'camelCaseOnly' } },
      esbuild: { jsx: 'automatic' }, define: { __APP_VERSION__: '"e2e"', __ANTSEED_SYSTEM_PROXY_PORT__: '8378' },
      server: { host: '127.0.0.1', port: 0, proxy: { '/_antseed': base, '/v1': base }, fs: { allow: [resolve(import.meta.dirname, '../..')] } },
    });
    await vite.listen();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await writeBuyerRoute(port, { kind: 'model', model: 'model-a' });
      routing.mode = 'first';
      await page.route('**/_antseed/routing-services', (route) => route.fulfill({
        status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Buyer upgrade required for routing discovery' }),
      }));
      await page.goto(`${vite.resolvedUrls!.local[0]}e2e/levanto.html`);
      await page.getByRole('button', { name: /Model A|model-a/ }).first().waitFor();
      await page.getByRole('button', { name: /Model A|model-a/ }).first().click();
      await page.getByRole('alert').filter({ hasText: 'Buyer upgrade required' }).waitFor();
      await page.getByRole('button', { name: /Model A|model-a/ }).first().click();
      await page.unroute('**/_antseed/routing-services');
      await page.route('**/_antseed/routing-services', (route) => route.fulfill({
        contentType: 'application/json', body: JSON.stringify({ ok: true, services: [] }),
      }));
      await page.getByRole('button', { name: 'Refresh catalog' }).click();
      await page.getByRole('button', { name: /Model A|model-a/ }).first().click();
      await page.getByRole('listbox').waitFor();
      expect(await page.getByRole('group', { name: 'Routing services' }).count()).toBe(0);
      expect(await page.getByText('No routing services discovered', { exact: false }).count()).toBe(0);
      expect(await page.getByRole('alert').count()).toBe(0);
      await page.getByRole('button', { name: /Model A|model-a/ }).first().click();
      await page.unroute('**/_antseed/routing-services');
      await page.getByRole('button', { name: 'Refresh catalog' }).click();
      await page.getByRole('button', { name: /Model A|model-a/ }).first().click();
      await page.getByRole('option').filter({ hasText: 'Router' }).waitFor();
      expect(await page.getByRole('listbox').getByRole('combobox').count()).toBe(0);
      await page.getByRole('button', { name: /Model A|model-a/ }).first().click();
      await page.getByRole('button', { name: 'Models', exact: true }).click();
      await page.setViewportSize({ width: 480, height: 900 });
      await page.getByPlaceholder('Search models or routers').fill('Levanto');
      await page.getByRole('button').filter({ hasText: 'Levanto' }).waitFor();
      await page.getByPlaceholder('Search models or routers').fill('');
      const routerCatalogRow = page.getByRole('tabpanel').getByRole('button').filter({ hasText: 'Levanto' });
      await routerCatalogRow.getByText('Levanto', { exact: true }).last().waitFor();
      expect(await routerCatalogRow.getByText('fake-levanto', { exact: true }).count()).toBe(0);
      // Seller and price share the meta line; poll so a mid-render layout is not sampled.
      await waitUntil(async () => {
        const sellerBounds = await routerCatalogRow.getByText('Levanto', { exact: true }).last().boundingBox();
        const priceBounds = await routerCatalogRow.getByText(paid ? '$0.001 / request' : 'Free', { exact: true }).boundingBox();
        return !!sellerBounds && !!priceBounds && sellerBounds.x < priceBounds.x && Math.abs(sellerBounds.y - priceBounds.y) < 4;
      }, 5_000);
      await routerCatalogRow.locator('..').getByRole('button', { name: /Model A/ }).waitFor();
      expect(await page.getByRole('tabpanel').getByLabel('Routing services').count()).toBe(0);
      await page.getByRole('tabpanel').screenshot({ path: '/tmp/antseed-levanto-models-page.png', animations: 'disabled' });
      await page.getByRole('button').filter({ hasText: 'Levanto' }).click();
      expect((await readRoute()).kind).toBe('model');
      const pricingInfo = page.getByRole('button', { name: 'About router pricing' });
      await page.getByText('Model inference is billed separately.', { exact: true }).waitFor({ state: 'hidden' });
      await pricingInfo.hover();
      await page.getByRole('tooltip').getByText('Model inference is billed separately.', { exact: true }).waitFor();
      await page.screenshot({ path: '/tmp/antseed-levanto-pricing-tooltip.png', animations: 'disabled' });
      await page.getByRole('heading', { name: 'Router settings', exact: true }).hover();
      await page.getByRole('tooltip').waitFor({ state: 'hidden' });
      await pricingInfo.focus();
      await page.getByRole('tooltip').getByText('Model inference is billed separately.', { exact: true }).waitFor();
      await page.getByRole('slider', { name: 'Cost / quality' }).fill('9');
      await page.getByRole('checkbox', { name: 'All supported models', exact: true }).uncheck();
      expect(await page.getByRole('button', { name: 'Use router', exact: true }).isDisabled()).toBe(true);
      await page.getByRole('checkbox', { name: /Model A/ }).click();
      expect((await readRoute()).kind).toBe('model');
      await page.reload();
      await page.getByRole('button', { name: 'Models', exact: true }).click();
      await page.getByRole('button').filter({ hasText: 'Levanto' }).click();
      expect(await page.getByRole('slider', { name: 'Cost / quality' }).inputValue()).toBe('9');
      expect(await page.getByRole('checkbox', { name: /Model A/ }).getAttribute('aria-checked')).toBe('true');
      expect(await page.getByRole('checkbox', { name: /Model B/ }).getAttribute('aria-checked')).toBe('false');
      expect((await readRoute()).kind).toBe('model');
      await page.getByPlaceholder('Search allowed models').fill('Model B');
      expect(await page.getByRole('checkbox', { name: /Model A/ }).count()).toBe(0);
      await page.getByPlaceholder('Search allowed models').fill('');
      expect(await page.getByRole('checkbox', { name: /Model A/ }).getAttribute('aria-checked')).toBe('true');
      await page.getByRole('tabpanel').screenshot({ path: '/tmp/antseed-levanto-router-settings.png', animations: 'disabled' });
      await page.getByRole('button', { name: 'Use router', exact: true }).click();
      await waitUntil(async () => (await readRoute()).allowedModels?.length === 1);
      expect((await readRoute()).allowedModels).toEqual([{ provider: inference.name, serviceId: 'model-a' }]);
      await page.reload();
      await page.getByRole('button', { name: 'Models', exact: true }).click();
      await page.getByRole('button').filter({ hasText: 'Levanto' }).click();
      expect(await page.getByRole('checkbox', { name: /Model A/ }).getAttribute('aria-checked')).toBe('true');
      expect(await page.getByRole('checkbox', { name: /Model B/ }).getAttribute('aria-checked')).toBe('false');
      expect(await page.getByRole('slider', { name: 'Cost / quality' }).inputValue()).toBe('9');
      await page.getByRole('checkbox', { name: /Model A/ }).click();
      await waitUntil(async () => (await readRoute()).allowedModels?.length === 0);
      expect((await send()).status).toBe(502);
      await page.getByRole('checkbox', { name: /Model A/ }).click();
      await waitUntil(async () => (await readRoute()).allowedModels?.length === 1);
      await page.getByRole('button', { name: 'Use router default', exact: true }).click();
      expect(await page.getByRole('button', { name: 'Selected router', exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole('button', { name: 'Save settings', exact: true }).count()).toBe(0);
      await waitUntil(async () => (await readRoute()).costQualityTradeoff === undefined);
      await page.getByRole('slider', { name: 'Cost / quality' }).fill('9');
      await page.getByRole('checkbox', { name: 'All supported models', exact: true }).check();
      expect(await page.getByRole('button', { name: 'Selected router', exact: true }).isDisabled()).toBe(true);
      await waitUntil(async () => (await readRoute()).allowedModels === undefined);
      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      await page.getByRole('button', { name: 'Refresh catalog' }).click();
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('log').getByText('Reply from model-a', { exact: true }).waitFor();
      await page.getByRole('log').getByText('Routed to Model A', { exact: true }).waitFor();
      expect(routing.requests.at(-1)?.routing).toMatchObject({ cost_quality_tradeoff: 9 });
      routing.mode = 'second';
      await page.getByLabel('Message', { exact: true }).fill('Choose another model');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('log').getByText('Reply from model-b', { exact: true }).waitFor();
      await page.getByRole('log').getByText('Routed to Model B', { exact: true }).waitFor();
      await page.getByRole('log').screenshot({ path: '/tmp/antseed-levanto-chat-indicators.png', animations: 'disabled' });
      await page.getByRole('button', { name: 'Router · Auto model' }).click();
      const chatRouterRow = page.getByRole('option').filter({ hasText: 'Levanto' });
      await chatRouterRow.getByText('Levanto', { exact: true }).last().waitFor();
      const chatSellerBounds = await chatRouterRow.getByText('Levanto', { exact: true }).last().boundingBox();
      const chatTagBounds = await chatRouterRow.getByText('Router', { exact: true }).boundingBox();
      expect(chatSellerBounds!.x).toBeLessThan(chatTagBounds!.x);
      await page.getByRole('listbox').screenshot({ path: '/tmp/antseed-levanto-vpr-browser.png', animations: 'disabled' });
      await page.getByRole('option').filter({ hasText: /Model A|model-a/ }).click();
      await page.getByLabel('Message', { exact: true }).fill('Fixed model again');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('log').getByText('Reply from model-a', { exact: true }).nth(1).waitFor();
      expect((await readRoute()).kind).toBe('model');
      await page.getByRole('button', { name: /Model A|model-a/ }).first().click();
      await page.getByRole('option').filter({ hasText: 'Router' }).click();
      await page.getByLabel('Message', { exact: true }).fill('Router again in this chat');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('log').getByText('Reply from model-b', { exact: true }).nth(1).waitFor();
      await page.reload();
      await page.getByRole('button', { name: 'Router · Auto model' }).waitFor();
      await page.getByRole('button', { name: 'Refresh catalog' }).click();
      expect((await readRoute()).kind).toBe('router');
      routing.mode = 'unavailable';
      const beforeFailure = inference.requests.length;
      await page.getByLabel('Message', { exact: true }).fill('Show a routing error');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('log').getByText('Router is temporarily unavailable', { exact: true }).waitFor();
      expect(inference.requests.length).toBe(beforeFailure);
      expect((await readRoute()).kind).toBe('router');
      routing.mode = 'first';
      await page.getByLabel('Message', { exact: true }).fill('Retry after router recovery');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('log').getByText('Reply from model-a', { exact: true }).waitFor();
      expect(errors).toEqual([]);
    } finally { await browser.close(); await vite.close(); }
  }, 60_000);

  it.skipIf(!paid)('does not charge for unscorable candidates or empty rankings and recovers without dropping constraints', async () => {
    await chooseRouter();
    const manager = nodes[2]!.buyerPaymentManager!;
    const authorized = manager.getCumulativeAmount(service.peerId);
    const inferenceCount = inference.requests.length;
    routing.mode = 'cannot-rank';
    expect((await send()).body.error.message).toContain('cannot rank');
    routing.mode = 'second';
    await writeBuyerRoute(port, { kind: 'router', service, costQualityTradeoff: 5,
      allowedModels: [{ provider: inference.name, serviceId: 'model-a' }] });
    expect((await send()).body.error.message).toContain('cannot rank');
    expect(manager.getCumulativeAmount(service.peerId)).toBe(authorized);
    expect(inference.requests.length).toBe(inferenceCount);
    expect(routing.requests.slice(-2).every(request => request.routing)).toBe(true);
    routing.mode = 'first';
    await chooseRouter();
    expect((await send()).body.model).toBe('model-a');
  });

  it.skipIf(!paid)('settles completed-request charges on Anvil and credits the selected seller', async () => {
    const manager = nodes[2]!.buyerPaymentManager!;
    const routingAuthorized = manager.getCumulativeAmount(service.peerId);
    const expectedInferenceCost = BigInt(inference.requests.length) * 20n;
    const routingChannel = manager.getActiveSession(service.peerId)!.sessionId;
    const close = await nodes[2]!.requestChannelClose(inferencePeer);
    expect(close, JSON.stringify(close)).toMatchObject({ status: 'closed' });
    expect(BigInt(close.finalAmount!)).toBe(expectedInferenceCost);
    const routingClose = await nodes[2]!.requestChannelClose(service.peerId);
    expect(routingClose, JSON.stringify(routingClose)).toMatchObject({ status: 'closed' });
    expect(BigInt(routingClose.finalAmount!)).toBe(routingAuthorized);
    await waitUntil(async () => BigInt((await chain!.channels.getFunction('channels')(routingChannel)).settled) === routingAuthorized, 30_000);
    await waitUntil(async () => BigInt(await chain!.usdc.getFunction('balanceOf')(inferenceSellerAddress)) > 0n, 30_000);
    expect(routingAuthorized).toBeGreaterThan(0n);
    expect(expectedInferenceCost).toBeGreaterThan(0n);
    const feeBps = BigInt(await chain!.channels.getFunction('PLATFORM_FEE_BPS')());
    expect(BigInt(await chain!.usdc.getFunction('balanceOf')(routingSellerAddress))).toBe(routingAuthorized * (10_000n - feeBps) / 10_000n);
    const balance = await chain!.deposits.getFunction('getBuyerBalance')(buyerAddress);
    expect(BigInt(balance[0]) + BigInt(balance[1])).toBe(10_000_000n - routingAuthorized - expectedInferenceCost);
  });

  it.skipIf(!paid)('refuses payment for invalid paid output, exposes disagreement, and still permits a direct model', async () => {
    routing.mode = 'invalid-json';
    await chooseRouter();
    const count = inference.requests.length;
    const before = nodes[2]!.buyerPaymentManager!.getCumulativeAmount(service.peerId);
    expect((await send()).status).toBe(502);
    expect(inference.requests.length).toBe(count);
    routing.mode = 'first';
    const retry = await send();
    expect(retry.status).toBe(502);
    expect(retry.body.error.message).toContain('payment');
    expect(nodes[2]!.buyerPaymentManager!.getCumulativeAmount(service.peerId)).toBe(before);
    await writeBuyerRoute(port, { kind: 'model', model: 'model-a' });
    expect((await send()).body.model).toBe('model-a');
  });
});
