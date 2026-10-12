import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { Wallet, ZeroAddress } from 'ethers';
import {
  buildAuthorizedWalletUrl,
  registerBuyerSetAuthorizedWalletCommand,
  runBrowserWalletAuthorization,
  setSelfAuthorizedWallet,
} from './set-authorized-wallet.js';

const buyer = '0x2222222222222222222222222222222222222222';
const otherOperator = '0x3333333333333333333333333333333333333333';
const contract = '0x4444444444444444444444444444444444444444';
const wallet = new Wallet('0x' + '01'.repeat(32));
const context = { wallet, address: buyer };

function selfAuthorizationFixture(current = ZeroAddress) {
  const calls: unknown[][] = [];
  return {
    calls,
    input: {
      context,
      evmChainId: 8453,
      depositsContractAddress: contract,
      client: {
        getOperator: async (address: string) => { calls.push(['getOperator', address]); return current; },
        getOperatorNonce: async (address: string) => { calls.push(['getOperatorNonce', address]); return 9007199254740993n; },
        setOperator: async (...args: unknown[]) => { calls.push(['setOperator', ...args]); return '0xtx'; },
      },
      sign: async (...args: unknown[]) => { calls.push(['sign', ...args]); return '0xsig'; },
    },
  };
}

test('self authorization signs the live nonce and sets the buyer as operator', async () => {
  const { input, calls } = selfAuthorizationFixture();
  assert.equal(await setSelfAuthorizedWallet(input), '0xtx');
  assert.deepEqual(calls, [
    ['getOperator', buyer],
    ['getOperatorNonce', buyer],
    ['sign', wallet, 8453, contract, buyer, 9007199254740993n],
    ['setOperator', wallet, buyer, buyer, 9007199254740993n, '0xsig'],
  ]);
});

test('self authorization is an idempotent no-op when the buyer is already authorized', async () => {
  const { input, calls } = selfAuthorizationFixture(buyer);
  assert.equal(await setSelfAuthorizedWallet(input), null);
  assert.deepEqual(calls, [['getOperator', buyer]]);
});

test('self authorization cannot replace a different authorized wallet', async () => {
  const { input, calls } = selfAuthorizationFixture(otherOperator);
  await assert.rejects(setSelfAuthorizedWallet(input), /Only that wallet can transfer authorization/);
  assert.deepEqual(calls, [['getOperator', buyer]]);
});

test('RPC, signing, and transaction failures propagate without retries', async () => {
  for (const stage of ['getOperator', 'getOperatorNonce', 'sign', 'setOperator'] as const) {
    const { input, calls } = selfAuthorizationFixture();
    const fail = async () => { throw new Error(`${stage} failed`); };
    if (stage === 'sign') input.sign = fail;
    else input.client[stage] = fail;
    await assert.rejects(setSelfAuthorizedWallet(input), new RegExp(`${stage} failed`));
    assert.equal(calls.filter(([name]) => name === 'setOperator').length, 0);
  }
});

test('builds a secure local wallet authorization URL', () => {
  assert.equal(
    buildAuthorizedWalletUrl(4321, 'secret token'),
    'http://127.0.0.1:4321?token=secret+token&page=pay&action=authorize',
  );
});

test('browser flow opens the connected-wallet page, waits for completion, and closes', async () => {
  const calls: unknown[][] = [];
  let onPaymentCompleted: (() => void) | undefined;
  await runBrowserWalletAuthorization({
    dataDir: '/tmp/buyer',
    configPath: '/tmp/config.json',
    createServer: async (options) => {
      calls.push(['createServer', options.port, options.dataDir, options.configPath]);
      onPaymentCompleted = options.onPaymentCompleted;
      return {
        bearerToken: 'token',
        server: { address: () => ({ port: 4321 }) },
        listen: async (options) => { calls.push(['listen', options]); },
        close: async () => { calls.push(['close']); },
      };
    },
    openBrowser: async (url) => {
      calls.push(['openBrowser', url]);
      onPaymentCompleted?.();
    },
    log: (message) => { calls.push(['log', message]); },
  });

  assert.deepEqual(calls, [
    ['createServer', 0, '/tmp/buyer', '/tmp/config.json'],
    ['listen', { port: 0, host: '127.0.0.1' }],
    ['log', 'Open this secure local page to connect the authorized wallet:\nhttp://127.0.0.1:4321?token=token&page=pay&action=authorize'],
    ['openBrowser', 'http://127.0.0.1:4321?token=token&page=pay&action=authorize'],
    ['close'],
  ]);
});

test('browser flow can print the URL without opening a browser', async () => {
  let complete!: () => void;
  const opened: string[] = [];
  await runBrowserWalletAuthorization({
    dataDir: '/tmp/buyer',
    createServer: async (options) => {
      complete = options.onPaymentCompleted;
      return {
        bearerToken: 'token',
        server: { address: () => ({ port: 4321 }) },
        listen: async () => { queueMicrotask(complete); },
        close: async () => {},
      };
    },
    log: (message) => { opened.push(message); },
  });
  assert.equal(opened.length, 1);
  assert.match(opened[0]!, /http:\/\/127\.0\.0\.1:4321/);
});

test('command defaults to browser authorization and exposes explicit self and no-open flags', () => {
  let help = '';
  const program = new Command().exitOverride().configureOutput({
    writeOut: (value) => { help += value; },
    writeErr: () => {},
  });
  const buyerCmd = program.command('buyer');
  registerBuyerSetAuthorizedWalletCommand(buyerCmd);
  const command = buyerCmd.commands[0]!;
  assert.equal(command.name(), 'set-authorized-wallet');
  assert.equal(command.registeredArguments.length, 0);
  assert.deepEqual(command.options.map((option) => option.long), ['--self', '--no-open']);
  command.outputHelp();
  assert.match(help, /connected external wallet.*--self.*buyer hot wallet/s);
});
