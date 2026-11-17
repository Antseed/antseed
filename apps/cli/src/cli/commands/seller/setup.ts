import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'node:readline/promises';
import { loadOrCreateIdentity } from '@antseed/node';
import { checkSellerReadiness } from '@antseed/node/payments';
import { getGlobalOptions } from '../types.js';
import { loadConfig, saveConfig } from '../../../config/loader.js';
import { ensureDerivedIdentityDisplayName } from '../../../config/identity-display-name.js';
import { assertValidConfig } from '../../../config/validation.js';
import { TRUSTED_PLUGINS } from '../../../plugins/registry.js';
import { installPlugin } from '../../../plugins/manager.js';
import type { AntseedConfig, SellerProviderConfig, SellerServiceConfig } from '../../../config/types.js';
import { isImageModelId } from '@antseed/provider-core';
import { parseServiceUnitBillingModelsInput } from '../../../config/service-metadata.js';
import { promptServiceCapabilities } from './capability-prompts.js';
import { createIdentityClient, createStakingClient, normalizeHttpRpcUrl } from '../../payment-utils.js';

export function buildSellerSetupProviderEntry(input: {
  plugin: string;
  baseUrl?: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
  services?: Record<string, SellerServiceConfig>;
}): SellerProviderConfig {
  const hasDefaults = input.inputUsdPerMillion !== undefined || input.outputUsdPerMillion !== undefined || input.cachedInputUsdPerMillion !== undefined;
  return {
    plugin: input.plugin,
    services: input.services ?? {},
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(hasDefaults
      ? {
          defaults: {
            inputUsdPerMillion: input.inputUsdPerMillion ?? 0,
            outputUsdPerMillion: input.outputUsdPerMillion ?? 0,
            ...(input.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: input.cachedInputUsdPerMillion } : {}),
          },
        }
      : {}),
  };
}

/** A typed price: blank is undefined, a non-negative number is itself, anything else is null (ask again). */
export function parsePriceAnswer(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Why a cached-input price can't go with this input price, or null. */
export function setupCachedPriceProblem(cached: number, input: number): string | null {
  return cached > input
    ? `At most the input price ($${input}): buyers skip an offer whose cached input costs more than its input.`
    : null;
}

const SETUP_PRICING_NOTE = [
  'Prices are in USD per 1M tokens.',
  'Cached input is the price of prompt tokens your upstream serves from its cache. Set it when your upstream',
  'charges less for cache hits. It must be at most the input price: buyers skip an offer priced above it.',
  'Leave it blank to bill cached input at the input price. When other sellers of a model set a cached-input',
  'price, buyers count offers of that model without one at half their trust score.',
];

async function askPrice(
  rl: { question(query: string): Promise<string> },
  query: string,
  check?: (value: number) => string | null,
): Promise<number | undefined> {
  for (;;) {
    const answer = parsePriceAnswer(await rl.question(query));
    if (answer === null) {
      console.log(chalk.yellow('  Use a number of USD (for example 0.5), or leave it blank.'));
      continue;
    }
    const problem = answer === undefined ? null : check?.(answer) ?? null;
    if (problem) {
      console.log(chalk.yellow(`  ${problem}`));
      continue;
    }
    return answer;
  }
}

export function applySellerSetupRpcUrl(config: AntseedConfig, input: string): void {
  const value = input.trim();
  if (!value) return;

  config.payments.crypto = config.payments.crypto ?? { chainId: 'base-mainnet' };
  if (value === '-') {
    delete config.payments.crypto.rpcUrl;
    return;
  }

  config.payments.crypto.rpcUrl = normalizeHttpRpcUrl(value, 'Base RPC URL');
}

async function printReadinessCheck(dataDir: string, configPath: string): Promise<void> {
  console.log(chalk.bold('Readiness check:\n'));
  try {
    const config = await loadConfig(configPath);
    const identity = await loadOrCreateIdentity(dataDir);
    const identityClient = createIdentityClient(config);
    const stakingClient = createStakingClient(config);
    const sellerContract = config.payments.sellerContract?.address;
    const checks = await checkSellerReadiness(identity, identityClient, stakingClient, sellerContract);

    for (const check of checks) {
      const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
      console.log(`  ${icon} ${chalk.bold(check.name)}: ${check.message}`);
      if (!check.passed && check.command) {
        console.log(chalk.dim(`    → ${check.command}`));
      }
    }
  } catch (err) {
    console.log(`  ${chalk.red('✗')} ${chalk.bold('Readiness check unavailable')}: ${(err as Error).message}`);
  }
  console.log('');
}

export function getSellerSetupCredentialHint(pluginName: string): string {
  switch (pluginName) {
    case 'anthropic':
      return 'export ANTHROPIC_API_KEY=<key>';
    case 'openai':
      return 'export OPENAI_API_KEY=<key>';
    case 'openai-responses':
      return 'sign in to Codex on this machine (~/.codex/auth.json)';
    case 'claude-oauth':
      return 'configure Claude OAuth credentials for the selected plugin';
    case 'claude-code':
      return 'sign in to Claude Code on this machine';
    case 'local-llm':
      return 'start your local LLM runtime (no API key required)';
    case 'typesafe':
      return 'export TYPESAFE_API_KEY=<key>';
    case 'venice-video':
      return 'export VENICE_VIDEO_API_KEY=<seller-api-key>';
    case 'fal-video':
      return 'export FAL_VIDEO_API_KEY=<seller-fal-key>';
    default:
      return `set the credentials required by ${pluginName}`;
  }
}

export function registerSellerSetupCommand(sellerCmd: Command): void {
  sellerCmd
    .command('setup')
    .description('Interactive seller setup — configure a provider and add services')
    .action(async () => {
      const globalOpts = getGlobalOptions(sellerCmd);
      const config = await loadConfig(globalOpts.config);
      await ensureDerivedIdentityDisplayName({
        config,
        configPath: globalOpts.config,
        dataDir: globalOpts.dataDir,
      });
      const rl = createInterface({ input: process.stdin, output: process.stdout });

      try {
        console.log(chalk.bold('\nAntseed seller setup\n'));

        const currentRpcUrl = config.payments.crypto?.rpcUrl;
        const rpcPrompt = currentRpcUrl
          ? `Custom Base network RPC URL [${currentRpcUrl}] (blank to keep, "-" to clear): `
          : 'Custom Base network RPC URL (optional, leave empty for default): ';
        const rpcUrlInput = await rl.question(rpcPrompt);
        try {
          applySellerSetupRpcUrl(config, rpcUrlInput);
        } catch (err) {
          console.error(chalk.red(`\nError: ${(err as Error).message}`));
          return;
        }
        console.log('');

        const providers = TRUSTED_PLUGINS.filter((plugin) => plugin.type === 'provider');
        console.log(chalk.bold('Available provider plugins:\n'));
        providers.forEach((plugin, index) => {
          console.log(`  ${chalk.cyan(String(index + 1))}. ${plugin.name.padEnd(16)} ${chalk.dim(plugin.description)}`);
        });
        console.log(`  ${chalk.cyan(String(providers.length + 1))}. ${chalk.dim('Custom npm package')}`);
        console.log('');

        const choice = await rl.question('Choose a plugin (number): ');
        const choiceNum = parseInt(choice.trim(), 10);

        let pluginName: string;
        let packageName: string;
        if (choiceNum > 0 && choiceNum <= providers.length) {
          const selected = providers[choiceNum - 1]!;
          pluginName = selected.name;
          packageName = selected.package;
        } else {
          const customPackage = await rl.question('npm package name: ');
          packageName = customPackage.trim();
          pluginName = packageName;
        }

        const defaultName = pluginName.replace(/^@antseed\/provider-/, '');
        const nameInput = await rl.question(`Provider name [${defaultName}]: `);
        const providerName = nameInput.trim() || defaultName;
        if (config.seller.providers[providerName]) {
          console.log(chalk.yellow(`\nProvider "${providerName}" already exists. Updating it.`));
        }

        const baseUrlInput = await rl.question('Base URL (leave empty for default): ');
        const baseUrl = baseUrlInput.trim() || undefined;

        console.log('');
        for (const line of SETUP_PRICING_NOTE) console.log(chalk.dim(line));
        const inputUsd = await askPrice(rl, 'Default input price (USD per 1M tokens): ');
        const outputUsd = await askPrice(rl, 'Default output price (USD per 1M tokens): ');
        const cachedUsd = await askPrice(
          rl,
          'Default cached-input price (USD per 1M tokens, enter to bill it at the input price): ',
          (value) => setupCachedPriceProblem(value, inputUsd ?? 0),
        );

        const spinner = ora(`Installing ${packageName}...`).start();
        try {
          await installPlugin(packageName);
          spinner.succeed(chalk.green(`Installed ${packageName}`));
        } catch (err) {
          spinner.fail(chalk.red(`Failed: ${(err as Error).message}`));
          return;
        }

        console.log(chalk.bold('\nAdd your first service:\n'));
        const services: Record<string, SellerServiceConfig> = {};
        let addMore = true;
        while (addMore) {
          const serviceIdInput = await rl.question('Service ID (e.g., claude-sonnet-4-6, gpt-4o): ');
          const serviceId = serviceIdInput.trim();
          if (!serviceId) break;

          const upstreamInput = await rl.question(`Upstream model [${serviceId}]: `);
          const svcInput = await askPrice(rl, 'Input price (USD/1M, or enter for provider default): ');
          const svcOutput = await askPrice(rl, 'Output price (USD/1M, or enter for provider default): ');
          // A model with its own prices doesn't take the provider's cached-input price, so ask for its own.
          const ownPrices = svcInput !== undefined || svcOutput !== undefined;
          const svcCached = ownPrices
            ? await askPrice(
                rl,
                'Cached-input price (USD/1M, enter to bill it at the input price): ',
                (value) => setupCachedPriceProblem(value, svcInput ?? inputUsd ?? 0),
              )
            : undefined;
          const categoriesStr = await rl.question('Categories (comma-separated, e.g., chat,coding): ');
          const serviceKind = isImageModelId(upstreamInput.trim() || serviceId) ? 'image' : 'text';
          const capabilities = await promptServiceCapabilities(rl, serviceKind);
          const unitBillingModelsStr = await rl.question('Unit billing models JSON by protocol (optional): ');

          const service: SellerServiceConfig = {};
          const upstreamModel = upstreamInput.trim();
          if (upstreamModel && upstreamModel !== serviceId) {
            service.upstreamModel = upstreamModel;
          }

          if (ownPrices) {
            // A price left blank is the provider default, as the prompt says.
            service.pricing = {
              inputUsdPerMillion: svcInput ?? inputUsd ?? 0,
              outputUsdPerMillion: svcOutput ?? outputUsd ?? 0,
              ...(svcCached !== undefined ? { cachedInputUsdPerMillion: svcCached } : {}),
            };
          }

          if (categoriesStr.trim()) {
            service.categories = categoriesStr.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
          }
          if (capabilities) {
            service.capabilities = capabilities;
          }
          if (unitBillingModelsStr.trim()) {
            service.unitBillingModels = parseServiceUnitBillingModelsInput(unitBillingModelsStr.trim());
          }

          services[serviceId] = service;
          console.log(chalk.green(`  Added: ${serviceId}`));

          const moreInput = await rl.question('\nAdd another service? (y/N): ');
          addMore = moreInput.trim().toLowerCase() === 'y';
        }

        const providerEntry = buildSellerSetupProviderEntry({
          plugin: pluginName,
          baseUrl,
          inputUsdPerMillion: inputUsd,
          outputUsdPerMillion: outputUsd,
          cachedInputUsdPerMillion: cachedUsd,
          services,
        });

        config.seller.providers[providerName] = providerEntry;

        // Optional verifier SDK — advertised in metadata so buyers can attest this node.
        const verifiers = TRUSTED_PLUGINS.filter((plugin) => plugin.type === 'verifier');
        if (verifiers.length > 0) {
          console.log(chalk.bold('\nVerifier SDK (optional — lets buyers cryptographically attest your node):\n'));
          verifiers.forEach((plugin, index) => {
            console.log(`  ${chalk.cyan(String(index + 1))}. ${plugin.name.padEnd(28)} ${chalk.dim(plugin.description)}`);
          });
          console.log(`  ${chalk.cyan('0')}. ${chalk.dim('None')}`);
          console.log('');
          const verifierChoice = await rl.question('Choose a verifier SDK (number, blank for none): ');
          const verifierNum = parseInt(verifierChoice.trim(), 10);
          if (verifierNum > 0 && verifierNum <= verifiers.length) {
            const selectedVerifier = verifiers[verifierNum - 1]!;
            const verifierSpinner = ora(`Installing ${selectedVerifier.package}...`).start();
            try {
              await installPlugin(selectedVerifier.package);
              verifierSpinner.succeed(chalk.green(`Installed ${selectedVerifier.package}`));
              config.seller.verifiers = [selectedVerifier.name];
            } catch (err) {
              verifierSpinner.fail(chalk.red(`Failed: ${(err as Error).message} — add it later with 'antseed seller start --verifiers ${selectedVerifier.name}'`));
            }
          }
        }

        assertValidConfig(config);
        await saveConfig(globalOpts.config, config);
        console.log(chalk.green(`\nProvider "${providerName}" saved to config.`));

        console.log(chalk.bold('\nNext steps:\n'));
        console.log(`  ${chalk.cyan('1.')} Set credentials: ${chalk.dim(getSellerSetupCredentialHint(pluginName))}`);
        console.log(`  ${chalk.cyan('2.')} Register on-chain: ${chalk.dim('antseed seller register')}`);
        console.log(`  ${chalk.cyan('3.')} Start selling: ${chalk.dim('antseed seller start')}`);
        console.log(chalk.dim('     Optional: stake ANTS for rewards with antseed seller stake <ants> --epochs <n>'));
        console.log('');

        await printReadinessCheck(globalOpts.dataDir, globalOpts.config);
      } finally {
        rl.close();
      }
    });
}
