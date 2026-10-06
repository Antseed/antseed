/**
 * `antseed ants` against an Anvil fork of Base mainnet at the latest block:
 * the real M001 contracts, a simulated cutover (registry pointers), and
 * every write path the dashboard exposes. Enabled by BASE_MAINNET_RPC_URL.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Interface, JsonRpcProvider, parseUnits } from 'ethers';
import { loadOrCreateIdentity, getChainConfig, IdentityClient, SellerRegistryClient } from '@antseed/node';
import { withAnvilFork } from '../../scripts/deployments/runtime/anvil.mjs';

const execFile = promisify(execFileCallback);
const forkUrl = process.env.BASE_MAINNET_RPC_URL;
const root = resolve(__dirname, '../..');
const cli = join(root, 'apps/cli/dist/cli/index.js');
const chain = getChainConfig('base-mainnet');
const EPOCH = 604_800;
const erc20 = new Interface(['function transfer(address,uint256)', 'function enableTransfers()', 'function owner() view returns (address)']);
const registryAbi = new Interface(['function setEmissions(address)', 'function setStaking(address)', 'function owner() view returns (address)']);
const accountingAbi = new Interface(['function accruePoints(bytes32,address,address,uint256)']);

interface Actor { dir: string; address: string; agentId: number; wallet: Awaited<ReturnType<typeof loadOrCreateIdentity>>['wallet']; }

describe.skipIf(!forkUrl)('antseed ants on a Base mainnet fork', () => {
  let rpcUrl: string;
  let provider: JsonRpcProvider;
  let release: () => void;
  let forkDone: Promise<void>;
  let a: Actor;
  let b: Actor;

  const rpc = (method: string, params: unknown[] = []) => provider.send(method, params);
  async function sendAs(from: string, to: string, data: string): Promise<void> {
    await rpc('anvil_impersonateAccount', [from]);
    await rpc('anvil_setBalance', [from, '0x56BC75E2D63100000']);
    const hash = await rpc('eth_sendTransaction', [{ from, to, data, gas: '0x2dc6c0' }]) as string;
    const receipt = await provider.waitForTransaction(hash);
    expect(receipt?.status).toBe(1);
  }
  async function advance(epochs = 1): Promise<void> {
    await rpc('evm_increaseTime', [EPOCH * epochs]);
    await rpc('evm_mine', []);
  }
  async function ants(actor: Actor, args: string[], expectFailure = false): Promise<string> {
    try {
      const result = await execFile(process.execPath, [cli, '--data-dir', actor.dir, '--config', join(actor.dir, 'config.json'), 'ants', ...args], {
        cwd: root, env: { ...process.env, ANTSEED_BASE_RPC_URL: rpcUrl, FORCE_COLOR: '0' }, maxBuffer: 16 * 1024 * 1024,
      });
      if (expectFailure) throw new Error(`expected failure: ants ${args.join(' ')}`);
      return `${result.stdout}${result.stderr}`;
    } catch (error) {
      if (!expectFailure) throw error;
      const failure = error as Error & { stdout?: string; stderr?: string };
      return `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
  }
  async function antsJson<T>(actor: Actor, args: string[]): Promise<T> {
    const result = await execFile(process.execPath, [cli, '--data-dir', actor.dir, '--config', join(actor.dir, 'config.json'), 'ants', ...args, '--json'], {
      cwd: root, env: { ...process.env, ANTSEED_BASE_RPC_URL: rpcUrl, FORCE_COLOR: '0' }, maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(result.stdout) as T;
  }
  async function actor(): Promise<Actor> {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-ants-e2e-'));
    await writeFile(join(dir, 'config.json'), JSON.stringify({ payments: { crypto: { chainId: 'base-mainnet', explorerApiUrl: '' } } }));
    const identity = await loadOrCreateIdentity(dir);
    await rpc('anvil_setBalance', [identity.wallet.address, '0x56BC75E2D63100000']);
    return { dir, address: identity.wallet.address, agentId: 0, wallet: identity.wallet };
  }

  beforeAll(async () => {
    await execFile('pnpm', ['--filter', '@antseed/cli', 'build'], { cwd: root, env: process.env });
    const ready = new Promise<string>((resolveReady) => {
      forkDone = withAnvilFork({ forkUrl: forkUrl!, chainId: 8453 }, async ({ rpcUrl: url }) => {
        resolveReady(url);
        await new Promise<void>((resolveRelease) => { release = resolveRelease; });
      }) as Promise<void>;
    });
    rpcUrl = await ready;
    provider = new JsonRpcProvider(rpcUrl, 8453, { staticNetwork: true });
    a = await actor();
    b = await actor();
    const tokenOwner = erc20.decodeFunctionResult('owner', await provider.call({ to: chain.antsTokenAddress, data: erc20.encodeFunctionData('owner') }))[0] as string;
    await sendAs(tokenOwner, chain.antsTokenAddress!, erc20.encodeFunctionData('enableTransfers'));
    await sendAs(chain.legacyEmissionsEscrowAddress!, chain.antsTokenAddress!, erc20.encodeFunctionData('transfer', [a.address, parseUnits('100000', 18)]));
    const identity = new IdentityClient({ rpcUrl, contractAddress: chain.identityRegistryAddress!, evmChainId: 8453 });
    const sellerRegistry = new SellerRegistryClient({ rpcUrl, contractAddress: chain.sellerRegistryAddress!, evmChainId: 8453 });
    for (const who of [a, b]) {
      who.agentId = await identity.register(who.wallet.connect(provider));
      await sellerRegistry.registerSeller(who.wallet.connect(provider), who.agentId);
    }
  }, 300_000);

  afterAll(async () => {
    release?.();
    await forkDone?.catch(() => undefined);
  });

  it('runs the full staking lifecycle, cutover, and reward flows', async () => {
    const status = await antsJson<{ phase: string; wallet: { ants: string } }>(a, ['status']);
    expect(['deployed', 'active']).toContain(status.phase);
    expect(BigInt(status.wallet.ants)).toBe(parseUnits('100000', 18));

    await ants(a, ['stake', '1000', '--agent', String(a.agentId), '--epochs', '8']);
    await ants(a, ['stake', '500', '--agent', String(a.agentId), '--epochs', '8']);
    expect(await ants(a, ['stake', '10', '--agent', '999999', '--epochs', '2'], true)).toMatch(/no seller bound/);
    type Positions = { positions: Array<{ id: number; agentId: number; amount: string; state: string; stakeEndEpoch: number; maxLocked: boolean; withdrawn: boolean }> };
    let positions = await antsJson<Positions>(a, ['positions']);
    expect(positions.positions).toHaveLength(2);
    expect(positions.positions.every((position) => position.state === 'pending')).toBe(true);
    const [second, first] = positions.positions.map((position) => position.id) as [number, number];

    await advance();
    await ants(a, ['split', String(first), '400']);
    positions = await antsJson<Positions>(a, ['positions']);
    const parts = positions.positions.filter((position) => position.id > second);
    expect(parts).toHaveLength(2);
    expect(positions.positions.some((position) => position.id === first)).toBe(false);
    // Closed positions leave the on-chain enumeration; the source position is only reachable by id now.
    const closed = await antsJson<{ positions: Array<{ id: number; state: string }> }>(a, ['positions']);
    expect(closed.positions.some((position) => position.id === first)).toBe(false);

    await advance();
    await ants(a, ['merge', ...parts.map((part) => String(part.id))]);
    positions = await antsJson<Positions>(a, ['positions']);
    const merged = positions.positions.find((position) => position.id > Math.max(...parts.map((part) => part.id)))!;
    expect(BigInt(merged.amount)).toBe(parseUnits('1000', 18));

    await advance();
    await ants(a, ['extend', String(merged.id), '--epochs', '4']);
    await ants(a, ['max-lock', String(second)]);
    await advance();
    positions = await antsJson<Positions>(a, ['positions']);
    expect(positions.positions.find((position) => position.id === second)?.maxLocked).toBe(true);
    expect(positions.positions.find((position) => position.id === merged.id)?.stakeEndEpoch).toBe(merged.stakeEndEpoch + 4);
    await ants(a, ['max-lock', String(second), '--off']);
    await advance();

    await ants(a, ['move', String(merged.id), '--to', String(b.agentId)]);
    await advance();
    positions = await antsJson<Positions>(a, ['positions']);
    const moved = positions.positions.find((position) => position.agentId === b.agentId && position.state === 'active')!;
    expect(BigInt(moved.amount)).toBe(parseUnits('1000', 18));
    const pools = await antsJson<{ pools: Array<{ agentId: number; activeStake: string }> }>(a, ['pools']);
    expect(pools.pools.some((pool) => pool.agentId === b.agentId && BigInt(pool.activeStake) > 0n)).toBe(true);

    expect(await ants(a, ['withdraw', String(moved.id), '--preview'])).toMatch(/Estimated principal burned/);
    expect(await ants(a, ['withdraw', String(moved.id)], true)).toMatch(/--accept-slashing/);
    await ants(a, ['withdraw', String(moved.id), '--accept-slashing', '--yes']);
    positions = await antsJson<Positions>(a, ['positions']);
    expect(positions.positions.some((position) => position.id === moved.id)).toBe(false);

    const registryOwner = registryAbi.decodeFunctionResult('owner', await provider.call({ to: chain.registryContractAddress, data: registryAbi.encodeFunctionData('owner') }))[0] as string;
    await sendAs(registryOwner, chain.registryContractAddress!, registryAbi.encodeFunctionData('setEmissions', [chain.usageAccountingAddress]));
    await sendAs(registryOwner, chain.registryContractAddress!, registryAbi.encodeFunctionData('setStaking', [chain.sellerRegistryAddress]));
    expect((await antsJson<{ phase: string }>(a, ['status'])).phase).toBe('active');
    await sendAs(chain.channelsContractAddress!, chain.usageAccountingAddress!, accountingAbi.encodeFunctionData('accruePoints', [`0x${'11'.repeat(32)}`, b.address, a.address, 5_000_000_000n]));
    await advance();

    type Rewards = { staker: { total: string }; sellerUsage: { total: string } };
    const rewards = await antsJson<Rewards>(a, ['rewards']);
    expect(BigInt(rewards.staker.total)).toBeGreaterThan(0n);
    expect(BigInt(rewards.sellerUsage.total)).toBeGreaterThan(0n);
    await ants(a, ['rewards', 'restake', String(second), '--epochs', '4']);
    await ants(a, ['rewards', 'claim', '--staker', '--seller']);
    const after = await antsJson<Rewards>(a, ['rewards']);
    expect(BigInt(after.staker.total)).toBe(0n);
    expect(BigInt(after.sellerUsage.total)).toBe(0n);
    positions = await antsJson<Positions>(a, ['positions']);
    expect(positions.positions.some((position) => position.state === 'pending' && position.agentId === a.agentId)).toBe(true);
  }, 900_000);
});
