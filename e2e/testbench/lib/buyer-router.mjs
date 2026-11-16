import { join } from 'node:path';

/**
 * The router `antseed buyer start` installs, built the same way for the in-process (sdk mode) buyer: router-local over
 * the effective buyer config, through the CLI's own resolveEffectiveBuyerConfig, buildRouterRuntimeEnvFromBuyerConfig
 * and buildPluginConfig. It enforces buyer.maxPricing (with provider and service overrides) and the reputation floor;
 * without a router BuyerProxy lets every peer through. `config` is the loaded CLI config (config/loader.js).
 */
export async function createBuyerRouter(repo, config) {
  const { resolveEffectiveBuyerConfig } = await import(join(repo, 'apps/cli/dist/config/effective.js'));
  const { buildPluginConfig } = await import(join(repo, 'apps/cli/dist/plugins/loader.js'));
  const { buildRouterRuntimeEnvFromBuyerConfig } = await import(join(repo, 'apps/cli/dist/cli/commands/buyer/start.js'));
  const plugin = (await import(join(repo, 'plugins/router-local/dist/index.js'))).default;
  const effective = resolveEffectiveBuyerConfig({ config, buyerOverrides: {} });
  const pluginConfig = buildPluginConfig(plugin.configSchema ?? plugin.configKeys ?? [], buildRouterRuntimeEnvFromBuyerConfig(effective));
  return plugin.createRouter(pluginConfig);
}
