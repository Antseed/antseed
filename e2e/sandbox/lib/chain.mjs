import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { assertLocalUrl } from './env.mjs';

const require = createRequire(import.meta.url);
const { Contract, JsonRpcProvider, Wallet } = require('ethers');

const ETH_BALANCE = '0x56BC75E2D63100000';
const WEEK = 604_800;

/**
 * Prepares a fresh Base fork for the sandbox. Every write happens on the local Anvil fork only:
 * mints USDC to the buyer and deposits it, registers and stakes each seller.
 */
export async function prepareChain({ rpcUrl, sdk, sellers, buyer: buyerIdentity, depositMicros, log = () => {} }) {
  assertLocalUrl(rpcUrl, 'Fork RPC');
  const provider = new JsonRpcProvider(rpcUrl, 8453, { cacheTimeout: -1, batchMaxCount: 1, staticNetwork: true });
  provider.pollingInterval = 100;
  assert.match(await provider.send('web3_clientVersion', []), /anvil/i, 'RPC is not an Anvil fork');
  assert.equal(await provider.send('eth_chainId', []), '0x2105', 'Fork must be Base mainnet');
  const chain = { ...sdk.getChainConfig('base-mainnet'), rpcUrl, fallbackRpcUrls: [] };
  const { resolveContractStack } = await import('../../../packages/node/dist/payments/contract-stack.js');
  const stack = await resolveContractStack(chain);
  assert.equal(stack.mode, 'recognized-usage', 'Fork must have the active recognized-usage contract stack; select a newer block');
  const clients = [];
  const client = (Client, contractAddress, extra = {}) => {
    const instance = new Client({ rpcUrl, contractAddress, evmChainId: 8453, fallbackRpcUrls: [], ...extra });
    clients.push(instance);
    return instance;
  };
  const transact = async (transaction) => {
    const receipt = await (await transaction).wait();
    assert.equal(receipt.status, 1);
    return receipt;
  };
  const impersonate = async (address, action) => {
    await provider.send('anvil_setBalance', [address, ETH_BALANCE]);
    await provider.send('anvil_impersonateAccount', [address]);
    try {
      return await action(await provider.getSigner(address));
    } finally {
      await provider.send('anvil_stopImpersonatingAccount', [address]);
    }
  };
  const destroy = () => {
    for (const instance of clients) instance.provider?.destroy?.();
    provider.destroy();
  };
  try {
    for (const identity of [buyerIdentity, ...sellers.map((seller) => seller.identity)]) {
      await provider.send('anvil_setBalance', [identity.wallet.address, ETH_BALANCE]);
    }
    const buyer = new Wallet(buyerIdentity.wallet.privateKey, provider);
    const usdc = new Contract(chain.usdcContractAddress, [
      'function masterMinter() view returns(address)', 'function configureMinter(address,uint256) returns(bool)',
      'function mint(address,uint256) returns(bool)', 'function approve(address,uint256) returns(bool)',
      'function balanceOf(address) view returns(uint256)',
    ], buyer);
    log(`Minting ${depositMicros} micro-USDC to the buyer (fork only)`);
    await impersonate(await usdc.masterMinter(), (signer) => transact(usdc.connect(signer).configureMinter(buyer.address, depositMicros)));
    await transact(usdc.mint(buyer.address, depositMicros));

    const identityClient = client(sdk.IdentityClient, chain.identityRegistryAddress);
    const registry = client(sdk.SellerRegistryClient, chain.sellerRegistryAddress);
    const pools = client(sdk.SellerPoolsClient, chain.sellerPoolsAddress, { antsTokenAddress: chain.antsTokenAddress });
    const token = new Contract(chain.antsTokenAddress, [
      'function owner() view returns(address)', 'function transfersEnabled() view returns(bool)',
      'function transferWhitelist(address) view returns(bool)', 'function setTransferWhitelist(address,bool)',
      'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)',
    ], provider);
    const minimumStake = await registry.minSellerPoolStake();
    const stake = minimumStake > 0n ? minimumStake : 1000n * 10n ** 18n;
    const fundingSource = chain.legacyEmissionsEscrowAddress;
    assert(await token.balanceOf(fundingSource) >= stake * BigInt(sellers.length), 'Fork ANTS funding source cannot cover the seller stakes');
    const sellerState = [];
    for (const seller of sellers) {
      log(`Registering and staking seller ${seller.id}`);
      const wallet = new Wallet(seller.identity.wallet.privateKey, provider);
      const agentId = await identityClient.register(wallet);
      await registry.registerSellerBinding(wallet, agentId);
      const whitelisted = [];
      if (!(await token.transfersEnabled())) {
        for (const address of [fundingSource, wallet.address]) {
          if (!(await token.transferWhitelist(address))) {
            await impersonate(await token.owner(), (signer) => transact(token.connect(signer).setTransferWhitelist(address, true)));
            whitelisted.push(address);
          }
        }
      }
      try {
        await impersonate(fundingSource, (signer) => transact(token.connect(signer).transfer(wallet.address, stake)));
        const epochs = Math.min(await pools.maxStakeEpochs(), Math.max(12, await pools.minStakeEpochs()));
        await pools.stake(wallet, agentId, stake, epochs);
      } finally {
        for (const address of whitelisted) {
          await impersonate(await token.owner(), (signer) => transact(token.connect(signer).setTransferWhitelist(address, false)));
        }
      }
      sellerState.push({ id: seller.id, address: wallet.address, agentId: String(agentId) });
    }
    const activation = await pools.stakeActivationDelay();
    assert(activation <= 12, 'Unexpected stake activation delay');
    await provider.send('evm_increaseTime', [(Number(activation) + 1) * WEEK]);
    await provider.send('evm_mine', []);
    for (const seller of sellerState) {
      assert(await registry.isStakedAboveMin(seller.address), `Seller ${seller.id} is not eligible after stake activation`);
    }
    const deposits = new Contract(chain.depositsContractAddress, [
      'function setOperator(address,address,uint256,bytes)', 'function deposit(address,uint256)',
      'function getBuyerBalance(address) view returns(uint256 available,uint256 reserved,uint256 lastActivityAt)',
    ], buyer);
    log('Depositing buyer USDC into AntseedDeposits');
    const signature = await sdk.signSetOperator(buyer, sdk.makeDepositsDomain(8453, chain.depositsContractAddress), { operator: buyer.address, nonce: 0n });
    await transact(deposits.setOperator(buyer.address, buyer.address, 0n, signature));
    await transact(usdc.approve(chain.depositsContractAddress, depositMicros));
    await transact(deposits.deposit(buyer.address, depositMicros));
    const balance = await deposits.getBuyerBalance(buyer.address);
    assert.equal(balance.available, BigInt(depositMicros));
    assert.equal(balance.reserved, 0n);
    const sellerUsdcBefore = {};
    for (const seller of sellerState) sellerUsdcBefore[seller.id] = String(await usdc.balanceOf(seller.address));
    return {
      chain,
      stake: String(stake),
      sellers: sellerState,
      buyer: buyer.address,
      startBlock: await provider.getBlockNumber(),
      sellerUsdcBefore,
      depositMicros: String(depositMicros),
    };
  } finally {
    destroy();
  }
}

export const LOCAL_CHAIN_ID = 31337;
export const LOCAL_DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const LOCAL_STAKE_MICROS = 50_000_000n;

/** Contracts a local-chain sandbox needs; Deploy.s.sol lays them out at deterministic addresses on a fresh Anvil. */
export const LOCAL_CONTRACT_KEYS = ['usdcContractAddress', 'identityRegistryAddress', 'registryContractAddress', 'stakingContractAddress', 'depositsContractAddress', 'channelsContractAddress', 'emissionsContractAddress'];

/**
 * Prepares a fresh local Anvil (chain 31337) where packages/contracts was just deployed from source
 * with script/Deploy.s.sol: funds wallets, mints MockUSDC, registers each seller in the mock ERC-8004
 * registry and stakes it in AntseedStaking, then sets the buyer operator and deposits. Mirrors the
 * setup of e2e/scripts/full-payment-flow.mjs so CI coverage carries over.
 */
export async function prepareLocalChain({ rpcUrl, sdk, sellers, buyer: buyerIdentity, depositMicros, log = () => {} }) {
  assertLocalUrl(rpcUrl, 'Local RPC');
  const provider = new JsonRpcProvider(rpcUrl, LOCAL_CHAIN_ID, { cacheTimeout: -1, batchMaxCount: 1, staticNetwork: true });
  provider.pollingInterval = 100;
  try {
    assert.match(await provider.send('web3_clientVersion', []), /anvil/i, 'RPC is not Anvil');
    assert.equal(await provider.send('eth_chainId', []), '0x7a69', 'Local chain must be Anvil chain 31337');
    const chain = { ...sdk.getChainConfig('base-local'), rpcUrl, fallbackRpcUrls: [] };
    for (const key of LOCAL_CONTRACT_KEYS) {
      assert.notEqual(await provider.getCode(chain[key]), '0x', `${key} ${chain[key]} has no code; Deploy.s.sol layout no longer matches chain-config base-local`);
    }
    const transact = async (transaction) => {
      const receipt = await (await transaction).wait();
      assert.equal(receipt.status, 1);
      return receipt;
    };
    for (const identity of [buyerIdentity, ...sellers.map((seller) => seller.identity)]) {
      await provider.send('anvil_setBalance', [identity.wallet.address, ETH_BALANCE]);
    }
    const usdcAbi = ['function mint(address,uint256)', 'function approve(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)'];
    const buyer = new Wallet(buyerIdentity.wallet.privateKey, provider);
    const usdc = new Contract(chain.usdcContractAddress, usdcAbi, buyer);
    const identityAbi = ['function register() returns(uint256)', 'event Registered(uint256 indexed agentId, address indexed owner)'];
    const stakingAbi = ['function stake(uint256,uint256)', 'function isStakedAboveMin(address) view returns(bool)'];
    const sellerState = [];
    for (const seller of sellers) {
      log(`Registering and staking seller ${seller.id} (local MockERC8004 + AntseedStaking)`);
      const wallet = new Wallet(seller.identity.wallet.privateKey, provider);
      await transact(usdc.mint(wallet.address, LOCAL_STAKE_MICROS));
      const identity = new Contract(chain.identityRegistryAddress, identityAbi, wallet);
      const receipt = await transact(identity.register());
      const registered = receipt.logs.map((entry) => { try { return identity.interface.parseLog(entry); } catch { return null; } }).find((parsed) => parsed?.name === 'Registered');
      assert(registered, `Seller ${seller.id}: no Registered event`);
      const agentId = registered.args.agentId;
      await transact(usdc.connect(wallet).approve(chain.stakingContractAddress, LOCAL_STAKE_MICROS));
      const staking = new Contract(chain.stakingContractAddress, stakingAbi, wallet);
      await transact(staking.stake(agentId, LOCAL_STAKE_MICROS));
      assert(await staking.isStakedAboveMin(wallet.address), `Seller ${seller.id} is not staked above the minimum`);
      sellerState.push({ id: seller.id, address: wallet.address, agentId: String(agentId) });
    }
    log(`Minting ${depositMicros} MockUSDC to the buyer and depositing it`);
    await transact(usdc.mint(buyer.address, depositMicros));
    const deposits = new Contract(chain.depositsContractAddress, [
      'function setOperator(address,address,uint256,bytes)', 'function deposit(address,uint256)',
      'function getBuyerBalance(address) view returns(uint256 available,uint256 reserved,uint256 lastActivityAt)',
    ], buyer);
    const signature = await sdk.signSetOperator(buyer, sdk.makeDepositsDomain(LOCAL_CHAIN_ID, chain.depositsContractAddress), { operator: buyer.address, nonce: 0n });
    await transact(deposits.setOperator(buyer.address, buyer.address, 0n, signature));
    await transact(usdc.approve(chain.depositsContractAddress, depositMicros));
    await transact(deposits.deposit(buyer.address, depositMicros));
    const balance = await deposits.getBuyerBalance(buyer.address);
    assert.equal(balance.available, BigInt(depositMicros));
    assert.equal(balance.reserved, 0n);
    const sellerUsdcBefore = {};
    for (const seller of sellerState) sellerUsdcBefore[seller.id] = String(await usdc.balanceOf(seller.address));
    return {
      chain,
      stake: String(LOCAL_STAKE_MICROS),
      sellers: sellerState,
      buyer: buyer.address,
      startBlock: await provider.getBlockNumber(),
      sellerUsdcBefore,
      depositMicros: String(depositMicros),
    };
  } finally {
    provider.destroy();
  }
}

/** Read-only view of chain state for status and settlement checks. */
export function chainReader(rpcUrl, chain) {
  assertLocalUrl(rpcUrl, 'Sandbox RPC');
  const provider = new JsonRpcProvider(rpcUrl, chain.evmChainId ?? 8453, { cacheTimeout: -1, batchMaxCount: 1, staticNetwork: true });
  provider.pollingInterval = 100;
  const deposits = new Contract(chain.depositsContractAddress, [
    'function getBuyerBalance(address) view returns(uint256 available,uint256 reserved,uint256 lastActivityAt)',
  ], provider);
  const usdc = new Contract(chain.usdcContractAddress, ['function balanceOf(address) view returns(uint256)'], provider);
  const channels = new Contract(chain.channelsContractAddress, [
    'event ChannelSettled(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint128 cumulativeAmount,uint128 delta,uint128 totalSettled,uint256 platformFee,bytes metadata)',
  ], provider);
  const channelsRead = new Contract(chain.channelsContractAddress, [
    'function channels(bytes32) view returns(address buyer,address seller,uint128 deposit,uint128 settled,bytes32 metadataHash,uint256 deadline,uint256 settledAt,uint256 closeRequestedAt,uint8 status)',
    'function requestClose(bytes32 channelId)',
    'function withdraw(bytes32 channelId)',
  ], provider);
  return {
    provider,
    async buyerBalance(address) {
      const value = await deposits.getBuyerBalance(address);
      return { available: value.available, reserved: value.reserved };
    },
    usdcBalance: (address) => usdc.balanceOf(address),
    async settledEvents(buyer, seller, fromBlock) {
      return channels.queryFilter(channels.filters.ChannelSettled(null, buyer, seller), fromBlock);
    },
    async warp(seconds) {
      await provider.send('evm_increaseTime', [seconds]);
      await provider.send('evm_mine', []);
    },
    /** On-chain channel row (amounts as micro-USDC strings); status 0 None, 1 Active, 2 Settled/Closed, 3 TimedOut. */
    async channelState(channelId) {
      const row = await channelsRead.channels(channelId);
      return { buyer: row.buyer, seller: row.seller, deposit: String(row.deposit), settled: String(row.settled), closeRequestedAt: Number(row.closeRequestedAt), status: Number(row.status) };
    },
    /** Sends a channel call as `from` via Anvil impersonation (no key needed; gas is topped up). */
    async sendAs(from, method, args) {
      await provider.send('anvil_setBalance', [from, '0x8AC7230489E80000']);
      await provider.send('anvil_impersonateAccount', [from]);
      try {
        const data = channelsRead.interface.encodeFunctionData(method, args);
        const hash = await provider.send('eth_sendTransaction', [{ from, to: chain.channelsContractAddress, data }]);
        const receipt = await provider.waitForTransaction(hash, 1, 30_000);
        if (!receipt || receipt.status !== 1) throw new Error(`${method}(${args.join(', ')}) reverted`);
        return receipt;
      } finally {
        await provider.send('anvil_stopImpersonatingAccount', [from]);
      }
    },
    close() { provider.destroy(); },
  };
}

/**
 * Exact settlement: per seller the on-chain ChannelSettled deltas equal what the buyer signed,
 * the seller received paid-minus-fees, the buyer's balance dropped by the total and nothing stays reserved.
 */
export async function verifySettlement({ reader, manifest, expectedBySeller }) {
  const observed = { sellers: {}, transactions: [] };
  let total = 0n;
  for (const seller of manifest.sellers) {
    const expected = BigInt(expectedBySeller[seller.id] ?? 0n);
    const events = await reader.settledEvents(manifest.buyer.address, seller.address, manifest.chainStartBlock);
    const paid = events.reduce((sum, event) => sum + event.args.delta, 0n);
    const fees = events.reduce((sum, event) => sum + event.args.platformFee, 0n);
    const gain = (await reader.usdcBalance(seller.address)) - BigInt(manifest.sellerUsdcBefore[seller.id]);
    observed.sellers[seller.id] = { expectedMicroUsdc: String(expected), paidMicroUsdc: String(paid), feesMicroUsdc: String(fees), sellerGainMicroUsdc: String(gain) };
    observed.transactions.push(...events.map((event) => event.transactionHash));
    assert.equal(paid, expected, `Seller ${seller.id}: settled ${paid} but the buyer signed for ${expected}`);
    assert.equal(gain, paid - fees, `Seller ${seller.id}: USDC gain must equal settled amount minus fees`);
    total += paid;
  }
  const balance = await reader.buyerBalance(manifest.buyer.address);
  observed.buyerAvailableMicroUsdc = String(balance.available);
  observed.reservedMicroUsdc = String(balance.reserved);
  observed.totalPaidMicroUsdc = String(total);
  assert.equal(balance.reserved, 0n, 'All channel reserves must be released after close');
  assert.equal(balance.available, BigInt(manifest.depositMicros) - total, 'Buyer available balance must drop by exactly the settled total');
  return observed;
}
