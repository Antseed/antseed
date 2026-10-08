#!/usr/bin/env node
// One sandbox seller per process, driven by the supervisor over IPC.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_PLUGINS } from './lib/config.mjs';
import { createRng, deriveSeed } from './lib/random.mjs';
import { sandboxNodeOptions } from './lib/node-options.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const log = (message) => console.log(`[seller] ${new Date().toISOString()} ${message}`);
let seller = null;
let stopping = false;
// Sandbox router state: rankings are shuffled with a seeded RNG (reset per scenario run) and counted.
const routerState = { seed: 1, sequence: 0, ranked: 0, rejected: 0, seen: new Map() };

function sandboxRouterProvider(sdk, priceUsd, models) {
  const service = 'levanto-route';
  const json = (request, statusCode, body, contentType = 'application/json') => ({ requestId: request.requestId, statusCode, headers: { 'content-type': contentType }, body: Buffer.from(JSON.stringify(body)) });
  return {
    name: 'sandbox-levanto',
    services: [service],
    pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    maxConcurrency: 10,
    serviceApiProtocols: { [service]: ['model-routing'] },
    serviceUnitBillingModels: { [service]: { 'model-routing': { version: 1, components: [{ unit: 'completed_requests', priceUsd: Number(priceUsd) }] } } },
    getCapacity: () => ({ current: 0, max: 10 }),
    async handleRequest(request) {
      // One routing service per seller: IRP requests no longer carry x-antseed-service.
      const requested = request.headers['x-antseed-service'];
      if (requested && requested !== service) return json(request, 404, { detail: 'Unknown service' }, 'application/problem+json');
      if (request.method === 'GET' && request.path === '/v1/routing/models') return json(request, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
      let body;
      try {
        body = JSON.parse(Buffer.from(request.body).toString());
        sdk.validateRoutingRankRequest(body);
      } catch {
        routerState.rejected += 1;
        return json(request, 400, { detail: 'Invalid IRP rank request' }, 'application/problem+json');
      }
      const shuffled = [...body.routing.candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      // Keyed by request content (workload prompts start with their deterministic draw key), so the same
      // seed ranks the same request the same way regardless of arrival order; repeats are numbered.
      const key = JSON.stringify(body.request?.messages ?? body.request ?? null);
      const repeat = routerState.seen.get(key) ?? 0;
      routerState.seen.set(key, repeat + 1);
      if (routerState.seen.size > 100_000) routerState.seen.clear();
      const rng = createRng(deriveSeed(routerState.seed, 'router-rank', key, repeat));
      routerState.sequence += 1;
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const pick = Math.floor(rng.next() * (index + 1));
        [shuffled[index], shuffled[pick]] = [shuffled[pick], shuffled[index]];
      }
      routerState.ranked += 1;
      const ranked = shuffled.map((candidate) => ({ candidate_id: candidate.id }));
      log(`router ranked ${shuffled.length} candidates; first ${shuffled[0]?.id ?? 'none'}`);
      return json(request, 200, { id: request.requestId, object: 'routing.ranking', created: Math.floor(Date.now() / 1000), router: { id: 'sandbox-levanto', version: '1' }, ranked });
    },
  };
}

async function start({ id, dataDir, configPath, bootstrapNodes, payments, router }) {
  const sdk = await import(join(repo, 'packages/node/dist/index.js'));
  if (router) {
    if (typeof sdk.validateRoutingRankRequest !== 'function') throw new Error('topology.routers needs an @antseed/node build with model-routing (IRP) support');
    seller = new sdk.AntseedNode({ ...sandboxNodeOptions({ role: 'seller', dataDir, bootstrapNodes, payments }), displayName: 'Levanto' });
    seller.registerProvider(sandboxRouterProvider(sdk, router.priceUsd, router.models));
    await seller.start();
    log(`started router ${id} peer=${seller.peerId} dht=${seller.dhtPort} signaling=${seller.signalingPort}`);
    return { peerId: seller.peerId, dhtPort: seller.dhtPort, signalingPort: seller.signalingPort };
  }
  const { loadConfig } = await import(join(repo, 'apps/cli/dist/config/loader.js'));
  const { buildSellerPluginRuntimeEnv } = await import(join(repo, 'apps/cli/dist/cli/commands/seller/start.js'));
  const { buildPluginConfig } = await import(join(repo, 'apps/cli/dist/plugins/loader.js'));
  const config = await loadConfig(configPath);
  seller = new sdk.AntseedNode({ ...sandboxNodeOptions({ role: 'seller', dataDir, bootstrapNodes, payments }), displayName: `sandbox-${id}` });
  for (const [name, providerConfig] of Object.entries(config.seller.providers)) {
    const pluginDir = WORKSPACE_PLUGINS[providerConfig.plugin];
    if (!pluginDir) throw new Error(`Unsupported plugin ${providerConfig.plugin}`);
    const plugin = (await import(join(repo, 'plugins', pluginDir, 'dist/index.js'))).default;
    const runtimeEnv = buildSellerPluginRuntimeEnv(config.seller, name);
    const provider = await plugin.createProvider(buildPluginConfig(plugin.configSchema ?? plugin.configKeys ?? [], runtimeEnv));
    if (provider.init) await provider.init();
    const categories = Object.fromEntries(Object.entries(providerConfig.services).filter(([, service]) => service.categories?.length).map(([serviceId, service]) => [serviceId, service.categories]));
    if (Object.keys(categories).length) provider.serviceCategories = categories;
    seller.registerProvider(provider);
  }
  await seller.start();
  log(`started ${id} peer=${seller.peerId} dht=${seller.dhtPort} signaling=${seller.signalingPort}`);
  return { peerId: seller.peerId, dhtPort: seller.dhtPort, signalingPort: seller.signalingPort };
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    if (seller) await seller.stop();
  } catch (error) {
    log(`stop failed: ${error.message}`);
    code = 1;
  }
  process.exit(code);
}

process.on('message', async (message) => {
  try {
    if (message.type === 'start') process.send({ type: 'ready', ...(await start(message)) });
    else if (message.type === 'announce') {
      await seller?._announcer?.announce();
      process.send({ type: 'announced' });
    } else if (message.type === 'router') {
      if (message.op === 'seed') Object.assign(routerState, { seed: message.seed >>> 0, sequence: 0 }); routerState.seen.clear();
      process.send({ type: 'router-reply', requestId: message.requestId, seed: routerState.seed, sequence: routerState.sequence, ranked: routerState.ranked, rejected: routerState.rejected });
    } else if (message.type === 'stop') await stop(0);
  } catch (error) {
    log(`error: ${error.stack ?? error.message}`);
    process.send?.({ type: 'error', message: error.message });
  }
});
process.on('disconnect', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));
