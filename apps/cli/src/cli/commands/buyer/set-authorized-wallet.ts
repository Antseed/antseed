import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ZeroAddress } from 'ethers';
import type { DepositsClient } from '@antseed/node';
import type { CryptoContext } from '../../payment-utils.js';
import { getGlobalOptions } from '../types.js';

interface SetSelfAuthorizedWalletInput {
  context: Pick<CryptoContext, 'wallet' | 'address'>;
  client: Pick<DepositsClient, 'getOperator' | 'getOperatorNonce' | 'setOperator'>;
  evmChainId: number;
  depositsContractAddress: string;
  sign: (wallet: CryptoContext['wallet'], chainId: number, contract: string, operator: string, nonce: bigint) => Promise<string>;
}

interface AuthorizationServer {
  bearerToken?: string;
  server: { address: () => string | { port: number } | null };
  listen: (options: { port: number; host: string }) => Promise<unknown>;
  close: () => Promise<unknown>;
}

interface BrowserAuthorizationInput {
  dataDir: string;
  configPath?: string;
  openBrowser?: (url: string) => Promise<unknown>;
  createServer: (options: {
    port: number;
    dataDir: string;
    configPath?: string;
    onPaymentCompleted: () => void;
  }) => Promise<AuthorizationServer>;
  log?: (message: string) => void;
}

interface SetAuthorizedWalletOptions {
  self: boolean;
  open: boolean;
}

export function buildAuthorizedWalletUrl(port: number, token: string): string {
  const params = new URLSearchParams({ token, page: 'pay', action: 'authorize' });
  return `http://127.0.0.1:${port}?${params.toString()}`;
}

/** Open the existing wallet-connected authorization page and wait for confirmation. */
export async function runBrowserWalletAuthorization(input: BrowserAuthorizationInput): Promise<void> {
  const log = input.log ?? console.log;
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => { complete = resolve; });
  const server = await input.createServer({
    port: 0,
    dataDir: input.dataDir,
    ...(input.configPath ? { configPath: input.configPath } : {}),
    onPaymentCompleted: complete,
  });

  try {
    await server.listen({ port: 0, host: '127.0.0.1' });
    const bound = server.server.address();
    if (!bound || typeof bound === 'string') throw new Error('Wallet authorization server is not listening.');
    if (!server.bearerToken) throw new Error('Wallet authorization server did not provide a session token.');

    const url = buildAuthorizedWalletUrl(bound.port, server.bearerToken);
    log(`Open this secure local page to connect the authorized wallet:\n${url}`);
    if (input.openBrowser) {
      try {
        await input.openBrowser(url);
      } catch {
        log('Could not open a browser automatically; open the URL above manually.');
      }
    }
    await completed;
  } finally {
    await server.close();
  }
}

/** Initial self-authorization only: changing an existing wallet requires the current operator. */
export async function setSelfAuthorizedWallet(input: SetSelfAuthorizedWalletInput): Promise<string | null> {
  const { wallet, address: buyer } = input.context;
  const current = await input.client.getOperator(buyer);
  if (current.toLowerCase() === buyer.toLowerCase()) return null;
  if (current.toLowerCase() !== ZeroAddress) {
    throw new Error(`Authorized wallet is already set to ${current}. Only that wallet can transfer authorization; the buyer identity cannot replace it.`);
  }
  const nonce = await input.client.getOperatorNonce(buyer);
  const signature = await input.sign(wallet, input.evmChainId, input.depositsContractAddress, buyer, nonce);
  return input.client.setOperator(wallet, buyer, buyer, nonce, signature);
}

export function registerBuyerSetAuthorizedWalletCommand(buyerCmd: Command): void {
  buyerCmd
    .command('set-authorized-wallet')
    .description('Authorize an external wallet in the browser, or authorize the buyer wallet with --self')
    .option('--self', 'authorize the buyer hot wallet itself (requires ETH for gas)', false)
    .option('--no-open', 'print the secure local URL without opening a browser')
    .addHelpText('after', '\nBy default, opens the AI VPN wallet flow so the connected external wallet submits the transaction and pays gas. --self instead makes the buyer hot wallet its own authorized wallet. The authorized wallet controls withdrawals and future authorization transfers.')
    .action(async (options: SetAuthorizedWalletOptions) => {
      let spinner: ReturnType<typeof ora> | undefined;
      try {
        if (options.self && !options.open) throw new Error('--no-open cannot be used with --self.');

        const globalOpts = getGlobalOptions(buyerCmd);
        if (!options.self) {
          const { createServer } = await import('@antseed/payments');
          const openBrowser = options.open ? (await import('open')).default : undefined;
          await runBrowserWalletAuthorization({
            dataDir: globalOpts.dataDir,
            configPath: globalOpts.config,
            createServer,
            ...(openBrowser ? { openBrowser } : {}),
            log: (message) => console.log(chalk.dim(message)),
          });
          console.log(chalk.green('Authorized wallet confirmed.'));
          return;
        }

        const { loadConfig } = await import('../../../config/loader.js');
        const { loadCryptoContext, createDepositsClient, requireCryptoConfig } = await import('../../payment-utils.js');
        const { makeDepositsDomain, signSetOperator } = await import('@antseed/node');
        const config = await loadConfig(globalOpts.config);
        const crypto = requireCryptoConfig(config);
        const context = await loadCryptoContext(globalOpts.dataDir);
        console.log(chalk.dim(`Buyer: ${context.address}`));
        console.log(chalk.dim(`Chain: ${crypto.evmChainId} | Deposits: ${crypto.depositsContractAddress}`));
        console.log(chalk.yellow('The buyer wallet will control withdrawals and future authorization transfers.'));
        console.log(chalk.dim('The buyer wallet must have ETH on this chain to pay gas.'));
        spinner = ora('Authorizing buyer wallet...').start();
        const txHash = await setSelfAuthorizedWallet({
          context,
          client: createDepositsClient(config),
          evmChainId: crypto.evmChainId,
          depositsContractAddress: crypto.depositsContractAddress,
          sign: (wallet, chainId, contract, operator, nonce) =>
            signSetOperator(wallet, makeDepositsDomain(chainId, contract), { operator, nonce }),
        });
        spinner.succeed(chalk.green(txHash ? 'Buyer wallet authorized.' : 'Buyer wallet is already authorized; no transaction sent.'));
        if (txHash) console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        const message = `Failed to set authorized wallet: ${(err as Error).message}`;
        if (spinner) spinner.fail(chalk.red(message));
        else console.error(chalk.red(message));
        process.exitCode = 1;
      }
    });
}
