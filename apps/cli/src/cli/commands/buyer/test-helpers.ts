/** Test support for buyer commands: a temp data dir with an identity, a seeded channel store and a stubbed chain. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { Command } from 'commander';
import { ChannelsClient, DepositsClient, loadOrCreateIdentity, type ChannelInfo, type StoredChannel } from '@antseed/node';
import { openChannelStore } from '../../payment-utils.js';

const SELLER = '0x' + '44'.repeat(20);
const ZERO_ADDRESS = '0x' + '00'.repeat(20);
const ZERO_HASH = '0x' + '00'.repeat(32);

export const nowSecs = (): number => Math.floor(Date.now() / 1000);

/** An active paid row whose reserve the seller confirmed. */
export function buyerChannel(sessionId: string, buyerEvmAddr: string, overrides: Partial<StoredChannel> = {}): StoredChannel {
  const now = Date.now();
  return {
    sessionId,
    peerId: `seller-${sessionId.slice(2, 10)}`,
    role: 'buyer',
    channelKind: 'paid',
    sellerEvmAddr: SELLER,
    buyerEvmAddr,
    nonce: 0,
    authMax: '400000',
    deadline: nowSecs() + 900,
    previousSessionId: '',
    previousConsumption: '0',
    tokensDelivered: '0',
    requestCount: 1,
    reservedAt: now,
    settledAt: null,
    settledAmount: null,
    status: 'active',
    latestBuyerSig: null,
    latestSpendingAuthSig: null,
    latestMetadata: null,
    latestReserveDeadline: nowSecs() + 900,
    reserveAuthPending: false,
    confirmedReserveAmount: '1000000',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** The contract's record of a channel: 1 Active, 2 Settled, 3 TimedOut. */
export function onChain(buyer: string, status: 1 | 2 | 3, settled = 0n): ChannelInfo {
  return {
    buyer,
    seller: SELLER,
    deposit: 1_000_000n,
    settled,
    metadataHash: ZERO_HASH,
    deadline: 0n,
    settledAt: 0n,
    closeRequestedAt: 0n,
    status,
  };
}

/** What the contract returns for a channel id it has never seen. */
export const MISSING_ON_CHAIN: ChannelInfo = {
  buyer: ZERO_ADDRESS,
  seller: ZERO_ADDRESS,
  deposit: 0n,
  settled: 0n,
  metadataHash: ZERO_HASH,
  deadline: 0n,
  settledAt: 0n,
  closeRequestedAt: 0n,
  status: 0,
};

export interface BuyerCommandHarness {
  buyer: string;
  seed(...rows: StoredChannel[]): void;
  channel(sessionId: string): StoredChannel | null;
  /** Run `antseed buyer <args>` against the chain given per channel id (an Error makes that read fail). */
  run(
    register: (buyerCmd: Command) => void,
    args: string[],
    chain: Record<string, ChannelInfo | Error>,
  ): Promise<{ stdout: string; stderr: string }>;
}

export async function buyerCommandHarness(context: TestContext): Promise<BuyerCommandHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'antseed-buyer-command-'));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const identity = await loadOrCreateIdentity(dataDir);
  const configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ payments: { crypto: { chainId: 'base-local' } } }));
  const withStore = <T>(use: (store: ReturnType<typeof openChannelStore>) => T): T => {
    const store = openChannelStore(dataDir);
    try {
      return use(store);
    } finally {
      store.close();
    }
  };

  return {
    buyer: identity.wallet.address,
    seed: (...rows) => withStore((store) => rows.forEach((row) => store.upsertChannel(row))),
    channel: (sessionId) => withStore((store) => store.getChannel(sessionId)),
    async run(register, args, chain) {
      context.mock.method(ChannelsClient.prototype, 'getSession', async (channelId: string) => {
        const state = chain[channelId] ?? new Error(`no chain state stubbed for ${channelId}`);
        if (state instanceof Error) throw state;
        return state;
      });
      context.mock.method(DepositsClient.prototype, 'getBuyerBalance', async () => {
        throw new Error('deposits are not stubbed');
      });
      const log = context.mock.method(console, 'log', () => {});
      const warn = context.mock.method(console, 'warn', () => {});
      const error = context.mock.method(console, 'error', () => {});
      const program = new Command()
        .option('--data-dir <path>', '', dataDir)
        .option('--config <path>', '', configPath);
      register(program.command('buyer'));
      await program.parseAsync(['buyer', ...args], { from: 'user' });
      const text = (output: typeof log): string => output.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
      return { stdout: text(log), stderr: [text(warn), text(error)].filter(Boolean).join('\n') };
    },
  };
}
