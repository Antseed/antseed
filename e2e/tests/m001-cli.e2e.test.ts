import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity } from '../../packages/node/src/p2p/identity.js';
import { SellerPoolsRewardsClient } from '@antseed/node/payments';

const execFile = promisify(execFileCallback);
const existingSandboxOut = process.env.M001_SANDBOX_OUT;
const enabled = Boolean(
  process.env.M001_SANDBOX_RPC
  && process.env.ANTS_HOLDER
  && (process.env.BASE_MAINNET_RPC_URL || existingSandboxOut),
);
const root = resolve(__dirname, '../..');
const cli = join(root, 'apps/cli/dist/cli/index.js');

describe.skipIf(!enabled)('M001 CLI sandbox', () => {
  let out: string;
  let dataDir: string;
  let config: string;
  let walletAddress: string;
  let rpcUrl: string;
  let ownsSandbox = false;

  async function run(command: string[], expectFailure = false): Promise<string> {
    let result;
    try {
      result = await execFile(process.execPath, [cli, '--config', config, '--data-dir', dataDir, ...command], {
        cwd: root,
        env: process.env,
      });
    } catch (error) {
      if (!expectFailure) throw error;
      const failure = error as Error & { stdout?: string; stderr?: string };
      return `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    if (expectFailure) throw new Error(`Expected failure: ${command.join(' ')}`);
    return `${result.stdout}${result.stderr}`;
  }

  async function rpc(method: string, params: unknown[] = []): Promise<string> {
    const response = await fetch(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json() as { result: string; error?: { message: string } };
    if (payload.error) throw new Error(payload.error.message);
    return payload.result;
  }

  const nonce = () => rpc('eth_getTransactionCount', [walletAddress, 'latest']);

  async function contractUint(address: string, signature: string, args: string[] = []): Promise<bigint> {
    const result = await execFile('cast', ['call', address, signature, ...args, '--rpc-url', rpcUrl]);
    return BigInt(result.stdout.trim().split(/\s/)[0]);
  }

  async function runJson(command: string[]): Promise<unknown> {
    const result = await execFile(process.execPath, [cli, '--config', config, '--data-dir', dataDir, ...command], {
      cwd: root,
      env: process.env,
    });
    return JSON.parse(result.stdout);
  }

  async function sandbox(command: string[]) {
    return execFile('pnpm', ['m001:sandbox', ...command, '--out', out], { cwd: root, env: process.env });
  }

  beforeAll(async () => {
    ownsSandbox = !existingSandboxOut;
    out = existingSandboxOut ? resolve(existingSandboxOut) : await mkdtemp(join(tmpdir(), 'antseed-m001-sandbox-'));
    dataDir = await mkdtemp(join(tmpdir(), 'antseed-m001-cli-'));
    config = join(out, 'cli-config.json');
    await execFile('pnpm', ['--filter', '@antseed/cli', 'build'], { cwd: root, env: process.env });
    const identity = await loadOrCreateIdentity(dataDir);
    walletAddress = identity.wallet.address;
    if (ownsSandbox) {
      const port = new URL(process.env.M001_SANDBOX_RPC!).port || '8545';
      await execFile('pnpm', ['m001:sandbox', 'up', '--port', port, '--out', out], { cwd: root, env: process.env });
    }
    const settings = JSON.parse(await readFile(config, 'utf8'));
    rpcUrl = settings.payments.crypto.rpcUrl;
    expect(rpcUrl).toBe(process.env.M001_SANDBOX_RPC);
    expect(new URL(rpcUrl).hostname).toBe('127.0.0.1');
    expect(await rpc('web3_clientVersion')).toMatch(/^anvil\//);
    await sandbox(['fund-seller', walletAddress]);
  }, 900_000);

  afterAll(async () => {
    if (ownsSandbox) {
      try { await sandbox(['down']); } catch {}
      await rm(out, { recursive: true, force: true });
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rehearses minimal commands, explicit legacy staking, rewards, withdrawal safety, and mismatch rejection', async () => {
    const initialNonce = await nonce();
    for (const command of [
      ['seller', 'pool', 'bootstrap'], ['seller', 'pool', 'init'], ['seller', 'pool', 'claim-starter'],
      ['seller', 'pool', 'rewards'], ['seller', 'pool', 'rewards', 'claim'],
      ['seller', 'unstake'], ['seller', 'emissions', 'info'], ['network', 'contracts'],
      ['seller', 'stake', '10', '--epochs', '4', '--agent-id', '1'],
    ]) {
      expect(await run(command, true)).toMatch(/unknown (command|option)/);
    }
    expect(await run(['seller', 'stake', '10'], true)).toContain('antseed seller legacy stake');
    expect(await run(['seller', 'stake', '10', '--epochs', '4'], true)).toContain('antseed seller legacy stake');
    expect(await nonce()).toBe(initialNonce);
    const registration = await run(['seller', 'register']);
    const agentId = registration.match(/Agent ID:\s*(\d+)/)?.[1];
    expect(agentId).toBeTruthy();
    await run(['seller', 'legacy', 'stake', '10', '--agent-id', agentId!]);
    expect(await runJson(['seller', 'rewards', '--json'])).toMatchObject({ mode: 'legacy' });
    expect(await run(['seller', 'legacy', 'claim-starter'], true)).toContain('recognized-usage');

    await sandbox(['cutover']);
    expect(await runJson(['seller', 'rewards', '--json'])).toMatchObject({ mode: 'recognized-usage' });
    const beforeRejections = await nonce();
    expect(await run(['seller', 'legacy', 'stake', '10'], true)).toContain('antseed seller stake');
    expect(await run(['seller', 'stake', '10'], true)).toContain('--epochs');
    expect(await run(['seller', 'stake', '10', '--epochs', '4'], true)).toContain('antseed seller register');
    expect(await nonce()).toBe(beforeRejections);
    await sandbox(['fund-position-init', '5']);
    await run(['seller', 'legacy', 'claim-starter']);
    expect(await run(['seller', 'pool', 'positions'])).toContain('pending');
    await run(['seller', 'register', '--agent-id', agentId!]);
    const registeredNonce = await nonce();
    await run(['seller', 'register', '--agent-id', agentId!]);
    expect(await nonce()).toBe(registeredNonce);

    await sandbox(['advance-epoch', '2']);
    await sandbox(['fund-ants', walletAddress, '100']);
    await run(['seller', 'stake', '100', '--epochs', '4']);
    const positionsJson = await runJson(['seller', 'pool', 'positions', '--json']) as Array<{ id: number }>;
    expect(positionsJson.length).toBeGreaterThanOrEqual(2);
    const newestId = String(positionsJson.at(-1).id);
    await sandbox(['advance-epoch', '1']);
    await run(['seller', 'legacy', 'unstake']);
    expect(await runJson(['seller', 'status', '--json'])).toMatchObject({ onChain: { eligible: true, agentId: Number(agentId) }, onChainError: null });

    const settings = JSON.parse(await readFile(config, 'utf8')).payments.crypto;
    const tokenBalance = () => contractUint(settings.antsTokenAddress, 'balanceOf(address)(uint256)', [walletAddress]);
    const indexCursor = () => contractUint(settings.sellerPoolsRewardsAddress, 'poolRewardIndexNextEpoch(uint256)(uint256)', [agentId!]);
    const recordUsage = async () => {
      const recorder = settings.channelsContractAddress;
      await rpc('anvil_impersonateAccount', [recorder]);
      await rpc('anvil_setBalance', [recorder, '0x3635C9ADC5DEA00000']);
      try {
        await execFile('cast', ['send', settings.usageAccountingAddress,
          'accruePoints(bytes32,address,address,uint256)', `0x${'11'.repeat(32)}`,
          '0x000000000000000000000000000000000000bEEF', walletAddress, '1000000',
          '--from', recorder, '--unlocked', '--rpc-url', rpcUrl]);
      } finally { await rpc('anvil_stopImpersonatingAccount', [recorder]); }
    };
    const expectedRewards = async () => {
      const currentEpoch = Number(await contractUint(settings.usageAccountingAddress, 'currentEpoch()(uint256)'));
      const epochs = `[${Array.from({ length: currentEpoch }, (_, epoch) => epoch).join(',')}]`;
      const usage = await contractUint(settings.usageAccountingAddress, 'pendingEmissions(address,uint256[])(uint256,uint256)', [walletAddress, epochs]);
      const poolRewards = new SellerPoolsRewardsClient({ rpcUrl, contractAddress: settings.sellerPoolsRewardsAddress, evmChainId: 8453 });
      const amounts = await Promise.all(positionsJson.map(position => poolRewards.previewStakerReward(position.id)));
      return usage + amounts.reduce((total, amount) => total + amount, 0n);
    };

    await recordUsage();
    expect(await runJson(['seller', 'rewards', '--json'])).toMatchObject({ total: '0.0' });
    await sandbox(['advance-epoch', '1']);
    const beforeRead = [await nonce(), await tokenBalance(), await indexCursor(), await rpc('eth_blockNumber')];
    const preview = await runJson(['seller', 'rewards', '--json']) as { legacy: string; recognizedUsage: string; pool: string };
    expect(preview.legacy).toBe('0.0');
    expect(Number(preview.recognizedUsage)).toBeGreaterThan(0);
    expect(Number(preview.pool)).toBeGreaterThan(0);
    expect([await nonce(), await tokenBalance(), await indexCursor(), await rpc('eth_blockNumber')]).toEqual(beforeRead);
    const expected = await expectedRewards();
    const beforeClaim = await tokenBalance();
    expect(await run(['seller', 'rewards', 'claim'])).toContain('Claimed');
    expect(await tokenBalance() - beforeClaim).toBe(expected);
    expect(await runJson(['seller', 'rewards', '--json'])).toMatchObject({ total: '0.0' });
    const beforeRepeat = await nonce();
    expect(await run(['seller', 'rewards', 'claim'])).toContain('No pending seller rewards');
    expect(await nonce()).toBe(beforeRepeat);

    await recordUsage();
    await sandbox(['advance-epoch', '1']);
    const beforeWithdrawal = await nonce();
    expect(await run(['seller', 'pool', 'withdraw', newestId], true)).toContain('--accept-slashing');
    expect(await run(['seller', 'pool', 'withdraw', newestId, '--accept-slashing'], true)).toContain('--yes');
    expect(await nonce()).toBe(beforeWithdrawal);
    await run(['seller', 'pool', 'withdraw', newestId, '--accept-slashing', '--yes']);

    const sellerInfo = await runJson(['seller', 'rewards', '--json']) as {
      mode: string;
      legacy: unknown;
      recognizedUsage: unknown;
    };
    expect(sellerInfo.mode).toBe('recognized-usage');
    expect(sellerInfo).toHaveProperty('legacy');
    expect(sellerInfo).toHaveProperty('recognizedUsage');
    const rewards = await runJson(['seller', 'rewards', '--json']) as { total: string; poolPositions: Array<{ id: number; amount: string }> };
    expect(rewards).toHaveProperty('total');
    expect(Number(rewards.poolPositions.find(position => position.id === Number(newestId))?.amount)).toBeGreaterThan(0);
    const withdrawnExpected = await expectedRewards();
    const beforeWithdrawnClaim = await tokenBalance();
    await run(['seller', 'rewards', 'claim']);
    expect(await tokenBalance() - beforeWithdrawnClaim).toBe(withdrawnExpected);
    expect(await runJson(['seller', 'rewards', '--json'])).toMatchObject({ total: '0.0' });
    await run(['buyer', 'emissions', 'info']);

    const broken = JSON.parse(await readFile(config, 'utf8'));
    broken.payments.crypto.usageAccountingAddress = '0x0000000000000000000000000000000000000001';
    const brokenConfig = join(out, 'broken-cli-config.json');
    await writeFile(brokenConfig, JSON.stringify(broken, null, 2));
    const original = config;
    config = brokenConfig;
    const beforeMismatch = await nonce();
    expect(await run(['seller', 'rewards'], true)).toContain('Contract stack mismatch');
    expect(await run(['seller', 'rewards', 'claim'], true)).toContain('Contract stack mismatch');
    expect(await nonce()).toBe(beforeMismatch);
    config = original;
  }, 900_000);
});
