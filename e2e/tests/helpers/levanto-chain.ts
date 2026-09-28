import { spawn, execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet } from 'ethers';
import { loadOrCreateIdentity, type NodePaymentsConfig } from '@antseed/node';

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, '../../..');
const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export async function createLevantoChain(port: number) {
  const process = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const rpc = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 });
  const signer = new NonceManager(new Wallet(privateKey, rpc));
  const stop = async () => { rpc.destroy(); process.kill('SIGTERM'); };
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rpc.getBlockNumber(); break; }
      catch (error) { if (attempt === 50) throw error; await new Promise((resolveReady) => setTimeout(resolveReady, 100)); }
    }
    await execFile('forge', ['build', '--root', resolve(root, 'packages/contracts'), 'core/AntseedRegistry.sol', 'staking/AntseedStaking.sol', 'payments/AntseedDeposits.sol', 'payments/AntseedChannels.sol', 'test/mocks/MockUSDC.sol', 'test/mocks/MockERC8004Registry.sol'], { maxBuffer: 4 * 1024 * 1024 });
    async function deploy(name: string, args: unknown[] = []): Promise<Contract> {
      const artifact = JSON.parse(await readFile(resolve(root, `packages/contracts/out/${name}.sol/${name}.json`), 'utf8'));
      const deployed = await new ContractFactory(artifact.abi, artifact.bytecode.object, signer).deploy(...args);
      await deployed.waitForDeployment();
      return new Contract(await deployed.getAddress(), artifact.abi, signer);
    }
    const usdc = await deploy('MockUSDC');
    const identity = await deploy('MockERC8004Registry');
    const registry = await deploy('AntseedRegistry');
    const staking = await deploy('AntseedStaking', [await usdc.getAddress(), await registry.getAddress()]);
    const deposits = await deploy('AntseedDeposits', [await usdc.getAddress()]);
    const channels = await deploy('AntseedChannels', [await registry.getAddress()]);
    for (const [method, address] of [
      ['setChannels', await channels.getAddress()], ['setDeposits', await deposits.getAddress()],
      ['setStaking', await staking.getAddress()], ['setIdentityRegistry', await identity.getAddress()],
      ['setProtocolReserve', await signer.getAddress()],
    ]) await (await registry.getFunction(method!)(address)).wait();
    await (await deposits.getFunction('setRegistry')(await registry.getAddress())).wait();

    const payments: NodePaymentsConfig = {
      enabled: true, chainId: 31337, rpcUrl,
      usdcAddress: await usdc.getAddress(), identityRegistryAddress: await identity.getAddress(),
      stakingAddress: await staking.getAddress(), depositsAddress: await deposits.getAddress(), channelsAddress: await channels.getAddress(),
      settlementIdleMs: 1000, closeIdleMs: 60_000,
      minBudgetPerRequest: '10000', maxPerRequestUsdc: '100000', maxReserveAmountUsdc: '10000000',
    };
    let agentId = 0;
    async function fund(dataDir: string, seller: boolean) {
      const account = await loadOrCreateIdentity(dataDir);
      const address = account.wallet.address;
      await rpc.send('anvil_setBalance', [address, '0x56BC75E2D63100000']);
      if (seller) {
        const accountSigner = new NonceManager(new Wallet(account.wallet.privateKey, rpc));
        await (await identity.connect(accountSigner).getFunction('register()')()).wait();
        agentId++;
        await (await usdc.getFunction('mint')(await signer.getAddress(), 100_000_000n)).wait();
        await (await usdc.getFunction('approve')(await staking.getAddress(), 100_000_000n)).wait();
        await (await staking.getFunction('stakeFor')(address, agentId, 100_000_000n)).wait();
      } else {
        await (await usdc.getFunction('mint')(await signer.getAddress(), 10_000_000n)).wait();
        await (await usdc.getFunction('approve')(await deposits.getAddress(), 10_000_000n)).wait();
        await (await deposits.getFunction('deposit')(address, 10_000_000n)).wait();
      }
      return address;
    }
    return { payments, fund, stop, deposits, channels, rpc, usdc };
  } catch (error) { await stop(); throw error; }
}
