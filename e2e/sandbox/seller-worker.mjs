#!/usr/bin/env node
// One sandbox seller per process, driven by the supervisor over IPC.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_PLUGINS } from './lib/config.mjs';
import { sandboxNodeOptions } from './lib/node-options.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const log = (message) => console.log(`[seller] ${new Date().toISOString()} ${message}`);
let seller = null;
let stopping = false;

async function start({ id, dataDir, configPath, bootstrapNodes, payments }) {
  const sdk = await import(join(repo, 'packages/node/dist/index.js'));
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
    } else if (message.type === 'stop') await stop(0);
  } catch (error) {
    log(`error: ${error.stack ?? error.message}`);
    process.send?.({ type: 'error', message: error.message });
  }
});
process.on('disconnect', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));
