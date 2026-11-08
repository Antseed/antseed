import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { assertLocalUrl } from './env.mjs';
import { alignChainClock, DEFAULT_CONTRACT_LAYOUT, LOCAL_CHAIN_ID, LOCAL_DEPLOYER, LOCAL_DEPLOYER_KEY, localChainConfig, verifyLocalLayout } from './local-deploy.mjs';

const require = createRequire(import.meta.url);
const { Contract, Interface, JsonRpcProvider, JsonRpcSigner, Wallet } = require('ethers');

/**
 * Fees for transactions Anvil signs itself (impersonated accounts). The testbench chain charges no gas (Anvil runs with
 * --base-fee 0 --gas-price 0). Anvil 1.9 fills a fee-less eth_sendTransaction there with its 1 gwei suggested tip over a
 * 0 max fee and then rejects it ("max priority fee per gas higher than max fee per gas"); 1.3 filled it consistently.
 * So every send Anvil signs states its fees. Transactions our own wallets sign (sellers, buyer, the product code) get
 * fees from ethers' fee data and are unaffected.
 */
export const ANVIL_SIGNED_FEES = Object.freeze({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n });

/** Anvil's fee flags for every testbench chain (fork and local): no base fee, no gas price, no minimum tip. */
export const ANVIL_FEE_ARGS = Object.freeze(['--disable-min-priority-fee', '--base-fee', '0', '--gas-price', '0']);

/** The same fees as JSON-RPC quantities, for a raw eth_sendTransaction. */
export const ANVIL_SIGNED_RPC_FEES = Object.freeze({ maxFeePerGas: '0x0', maxPriorityFeePerGas: '0x0' });

/** A signer for an account Anvil signs for (impersonated): its sends carry ANVIL_SIGNED_FEES unless they set fees. */
export class AnvilSigner extends JsonRpcSigner {
  async sendUncheckedTransaction(tx) {
    const hasFees = tx.gasPrice != null || tx.maxFeePerGas != null || tx.maxPriorityFeePerGas != null;
    return super.sendUncheckedTransaction(hasFees ? tx : { ...tx, ...ANVIL_SIGNED_FEES });
  }
}

const ETH_BALANCE = '0x56BC75E2D63100000';
const WEEK = 604_800;
const USDC_ADMIN = ['function masterMinter() view returns(address)', 'function configureMinter(address,uint256) returns(bool)', 'function mint(address,uint256)', 'function transfer(address,uint256) returns(bool)'];
/** AntseedDeposits' default per-buyer credit limit (BASE_CREDIT_LIMIT); larger testbench deposits need an owner override. */
export const BASE_CREDIT_LIMIT_MICROS = 10_000_000n;

/**
 * Owner-only payment settings a topology can ask for, sent on Anvil by impersonating each contract's owner
 * (works on the fork and the local chain): a credit limit override so the buyer can deposit more than the
 * default 10 USDC, and the channels' top-up threshold (Base runs 65%; the source default is 85%).
 * Runs before the deposit, which is where the credit limit is checked.
 */
export async function applyOwnerSettings(provider, chain, { buyer, depositMicros, topUpThresholdBps, log = () => {} }) {
  const ownable = ['function owner() view returns(address)'];
  const asOwner = async (address, abi, action) => {
    const owner = await new Contract(address, ownable, provider).owner();
    await provider.send('anvil_setBalance', [owner, ETH_BALANCE]);
    await provider.send('anvil_impersonateAccount', [owner]);
    try {
      const receipt = await (await action(new Contract(address, abi, new AnvilSigner(provider, owner)))).wait();
      assert.equal(receipt.status, 1);
    } finally {
      await provider.send('anvil_stopImpersonatingAccount', [owner]);
    }
  };
  const applied = {};
  if (BigInt(depositMicros) > BASE_CREDIT_LIMIT_MICROS) {
    log(`Raising the buyer credit limit to ${depositMicros} micro-USDC (owner override, testbench chain only)`);
    await asOwner(chain.depositsContractAddress, ['function setCreditLimitOverride(address,uint256)'], (deposits) => deposits.setCreditLimitOverride(buyer, BigInt(depositMicros)));
    applied.creditLimitMicros = String(depositMicros);
  }
  if (topUpThresholdBps !== undefined) {
    log(`Setting the channels top-up threshold to ${topUpThresholdBps} bps`);
    await asOwner(chain.channelsContractAddress, ['function setTopUpSettledThresholdBps(uint256)'], (channels) => channels.setTopUpSettledThresholdBps(topUpThresholdBps));
    applied.topUpThresholdBps = topUpThresholdBps;
  }
  const threshold = await new Contract(chain.channelsContractAddress, ['function TOP_UP_SETTLED_THRESHOLD_BPS() view returns(uint256)'], provider).TOP_UP_SETTLED_THRESHOLD_BPS().catch(() => null);
  return { ...applied, ...(threshold !== null ? { topUpThresholdBpsOnChain: Number(threshold) } : {}) };
}

/**
 * The recognized-usage path a seller takes on Base: an ERC-8004 identity (`register(wallet)` returns the agent id),
 * a SellerRegistry binding, and an ANTS stake in its own seller pool, funded from `fundingSource` (an ANTS holder
 * impersonated on Anvil, whitelisted for the transfer while ANTS transfers are off). Then warps past the pools'
 * stake activation delay and checks every seller is eligible.
 */
async function stakeSellersInPools({ provider, sdk, chain, rpcUrl, evmChainId, sellers, impersonate, transact, register, fundingSource, log }) {
  const clients = [];
  const client = (Client, contractAddress, extra = {}) => {
    const instance = new Client({ rpcUrl, contractAddress, evmChainId, fallbackRpcUrls: [], ...extra });
    clients.push(instance);
    return instance;
  };
  try {
    const registry = client(sdk.SellerRegistryClient, chain.sellerRegistryAddress);
    const pools = client(sdk.SellerPoolsClient, chain.sellerPoolsAddress, { antsTokenAddress: chain.antsTokenAddress });
    const token = new Contract(chain.antsTokenAddress, [
      'function owner() view returns(address)', 'function transfersEnabled() view returns(bool)',
      'function transferWhitelist(address) view returns(bool)', 'function setTransferWhitelist(address,bool)',
      'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)',
    ], provider);
    const minimumStake = await registry.minSellerPoolStake();
    const stake = minimumStake > 0n ? minimumStake : 1000n * 10n ** 18n;
    assert(await token.balanceOf(fundingSource) >= stake * BigInt(sellers.length), 'ANTS funding source cannot cover the seller stakes');
    const sellerState = [];
    for (const seller of sellers) {
      log(`Registering and staking seller ${seller.id} (SellerRegistry + ANTS seller pool)`);
      const wallet = new Wallet(seller.identity.wallet.privateKey, provider);
      const agentId = await register(wallet);
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
    return { sellerState, stake };
  } finally {
    for (const instance of clients) instance.provider?.destroy?.();
  }
}

/**
 * Prepares a fresh Base fork for the testbench. Every write happens on the local Anvil fork only:
 * mints USDC to the buyer and deposits it, registers and stakes each seller.
 */
export async function prepareChain({ rpcUrl, sdk, sellers, buyer: buyerIdentity, depositMicros, topUpThresholdBps, log = () => {} }) {
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
      return await action(new AnvilSigner(provider, address));
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

    const { sellerState, stake } = await stakeSellersInPools({
      provider, sdk, chain, rpcUrl, evmChainId: 8453, sellers, impersonate, transact, log,
      register: async (wallet) => client(sdk.IdentityClient, chain.identityRegistryAddress).register(wallet),
      fundingSource: chain.legacyEmissionsEscrowAddress,
    });
    const deposits = new Contract(chain.depositsContractAddress, [
      'function setOperator(address,address,uint256,bytes)', 'function deposit(address,uint256)',
      'function getBuyerBalance(address) view returns(uint256 available,uint256 reserved,uint256 lastActivityAt)',
    ], buyer);
    const ownerSettings = await applyOwnerSettings(provider, chain, { buyer: buyer.address, depositMicros, topUpThresholdBps, log });
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
      stakeToken: 'ANTS',
      sellers: sellerState,
      buyer: buyer.address,
      startBlock: await provider.getBlockNumber(),
      sellerUsdcBefore,
      depositMicros: String(depositMicros),
      ownerSettings,
    };
  } finally {
    destroy();
  }
}

export { LOCAL_CHAIN_ID, LOCAL_DEPLOYER_KEY };
const LOCAL_STAKE_MICROS = 50_000_000n;

/**
 * Prepares a fresh local Anvil (chain 31337) where packages/contracts was just deployed from source by
 * lib/local-deploy.mjs: funds wallets, mints MockUSDC, registers each seller in the mock ERC-8004 registry and
 * stakes it, then sets the buyer operator and deposits. On the 'full' layout a seller stakes ANTS in its seller pool
 * through SellerRegistry, as on Base (the ANTS come from the legacy escrow, like on the fork); on 'payments' it
 * stakes USDC in AntseedStaking, mirroring e2e/scripts/full-payment-flow.mjs so CI coverage carries over.
 */
export async function prepareLocalChain({ rpcUrl, sdk, sellers, buyer: buyerIdentity, depositMicros, topUpThresholdBps, layout = DEFAULT_CONTRACT_LAYOUT, log = () => {} }) {
  assertLocalUrl(rpcUrl, 'Local RPC');
  const provider = new JsonRpcProvider(rpcUrl, LOCAL_CHAIN_ID, { cacheTimeout: -1, batchMaxCount: 1, staticNetwork: true });
  provider.pollingInterval = 100;
  try {
    assert.match(await provider.send('web3_clientVersion', []), /anvil/i, 'RPC is not Anvil');
    assert.equal(await provider.send('eth_chainId', []), '0x7a69', 'Local chain must be Anvil chain 31337');
    const chain = { ...localChainConfig(sdk.getChainConfig('base-local'), layout), rpcUrl, fallbackRpcUrls: [] };
    await verifyLocalLayout(provider, layout);
    const transact = async (transaction) => {
      const receipt = await (await transaction).wait();
      assert.equal(receipt.status, 1);
      return receipt;
    };
    const impersonate = async (address, action) => {
      await provider.send('anvil_setBalance', [address, ETH_BALANCE]);
      await provider.send('anvil_impersonateAccount', [address]);
      try {
        return await action(new AnvilSigner(provider, address));
      } finally {
        await provider.send('anvil_stopImpersonatingAccount', [address]);
      }
    };
    for (const identity of [buyerIdentity, ...sellers.map((seller) => seller.identity)]) {
      await provider.send('anvil_setBalance', [identity.wallet.address, ETH_BALANCE]);
    }
    const usdcAbi = ['function mint(address,uint256)', 'function approve(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)'];
    const buyer = new Wallet(buyerIdentity.wallet.privateKey, provider);
    const usdc = new Contract(chain.usdcContractAddress, usdcAbi, buyer);
    const identityAbi = ['function register() returns(uint256)', 'event Registered(uint256 indexed agentId, address indexed owner)'];
    /** MockERC8004Registry emits Registered rather than the ERC-721 Transfer IdentityClient reads the id from. */
    const registerIdentity = async (wallet) => {
      const identity = new Contract(chain.identityRegistryAddress, identityAbi, wallet);
      const receipt = await transact(identity.register());
      const registered = receipt.logs.map((entry) => { try { return identity.interface.parseLog(entry); } catch { return null; } }).find((parsed) => parsed?.name === 'Registered');
      assert(registered, `${wallet.address}: no Registered event`);
      return Number(registered.args.agentId);
    };
    let sellerState = [];
    let stake = LOCAL_STAKE_MICROS;
    let stakeToken = 'USDC';
    if (layout === 'full') {
      ({ sellerState, stake } = await stakeSellersInPools({
        provider, sdk, chain, rpcUrl, evmChainId: LOCAL_CHAIN_ID, sellers, impersonate, transact, log,
        register: registerIdentity, fundingSource: chain.legacyEmissionsEscrowAddress,
      }));
      stakeToken = 'ANTS';
    } else {
      const stakingAbi = ['function stake(uint256,uint256)', 'function isStakedAboveMin(address) view returns(bool)'];
      for (const seller of sellers) {
        log(`Registering and staking seller ${seller.id} (local MockERC8004 + AntseedStaking)`);
        const wallet = new Wallet(seller.identity.wallet.privateKey, provider);
        await transact(usdc.mint(wallet.address, LOCAL_STAKE_MICROS));
        const agentId = await registerIdentity(wallet);
        await transact(usdc.connect(wallet).approve(chain.stakingContractAddress, LOCAL_STAKE_MICROS));
        const staking = new Contract(chain.stakingContractAddress, stakingAbi, wallet);
        await transact(staking.stake(agentId, LOCAL_STAKE_MICROS));
        assert(await staking.isStakedAboveMin(wallet.address), `Seller ${seller.id} is not staked above the minimum`);
        sellerState.push({ id: seller.id, address: wallet.address, agentId: String(agentId) });
      }
    }
    const ownerSettings = await applyOwnerSettings(provider, chain, { buyer: buyer.address, depositMicros, topUpThresholdBps, log });
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
    // The full layout's Anvil started in the past to absorb the setup warps; from here on it runs at wall time.
    const clockAlignedSeconds = await alignChainClock(provider);
    if (clockAlignedSeconds) log(`Chain clock moved ${clockAlignedSeconds}s forward to wall time after setup`);
    return {
      chain,
      stake: String(stake),
      stakeToken,
      clockAlignedSeconds,
      sellers: sellerState,
      buyer: buyer.address,
      startBlock: await provider.getBlockNumber(),
      sellerUsdcBefore,
      depositMicros: String(depositMicros),
      ownerSettings,
    };
  } finally {
    provider.destroy();
  }
}

/** Read-only view of chain state for status and settlement checks. */
export function chainReader(rpcUrl, chain) {
  assertLocalUrl(rpcUrl, 'Testbench RPC');
  const provider = new JsonRpcProvider(rpcUrl, chain.evmChainId ?? 8453, { cacheTimeout: -1, batchMaxCount: 1, staticNetwork: true });
  provider.pollingInterval = 100;
  const deposits = new Contract(chain.depositsContractAddress, [
    'function getBuyerBalance(address) view returns(uint256 available,uint256 reserved,uint256 lastActivityAt)',
  ], provider);
  const usdc = new Contract(chain.usdcContractAddress, ['function balanceOf(address) view returns(uint256)'], provider);
  const channels = new Contract(chain.channelsContractAddress, [
    'event ChannelSettled(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint128 cumulativeAmount,uint128 delta,uint128 totalSettled,uint256 platformFee,bytes metadata)',
  ], provider);
  const depositsRegistry = new Contract(chain.depositsContractAddress, ['function registry() view returns(address)'], provider);
  let feeRecipient = null;
  const channelsRead = new Contract(chain.channelsContractAddress, [
    'function channels(bytes32) view returns(address buyer,address seller,uint128 deposit,uint128 settled,bytes32 metadataHash,uint256 deadline,uint256 settledAt,uint256 closeRequestedAt,uint8 status)',
    'function requestClose(bytes32 channelId)',
    'function withdraw(bytes32 channelId)',
  ], provider);
  /** Any contract call as `from` via Anvil impersonation (gas topped up); throws when it reverts. */
  const sendContractAs = async (from, to, abiOrInterface, method, args) => {
    const iface = abiOrInterface instanceof Interface ? abiOrInterface : new Interface(abiOrInterface);
    await provider.send('anvil_setBalance', [from, '0x8AC7230489E80000']);
    await provider.send('anvil_impersonateAccount', [from]);
    try {
      const data = iface.encodeFunctionData(method, args);
      const hash = await provider.send('eth_sendTransaction', [{ from, to, data, ...ANVIL_SIGNED_RPC_FEES }]);
      const receipt = await provider.waitForTransaction(hash, 1, 30_000);
      if (!receipt || receipt.status !== 1) throw new Error(`${method}(${args.join(', ')}) reverted`);
      return receipt;
    } finally {
      await provider.send('anvil_stopImpersonatingAccount', [from]);
    }
  };
  return {
    provider,
    async buyerBalance(address) {
      const value = await deposits.getBuyerBalance(address);
      return { available: value.available, reserved: value.reserved };
    },
    usdcBalance: (address) => usdc.balanceOf(address),
    /** Where platform fees go: the registry's protocolReserve (zero address means no fee is taken). */
    async feeRecipient() {
      if (feeRecipient) return feeRecipient;
      const registry = new Contract(await depositsRegistry.registry(), ['function protocolReserve() view returns(address)'], provider);
      feeRecipient = await registry.protocolReserve();
      return feeRecipient;
    },
    /**
     * Balances the payment oracle compares before and after a run (bigints, micro-USDC): the buyer's deposit,
     * the sellers' USDC and the fee recipient's USDC. Shaped like e2e/stress/chain.mjs chainSnapshot.
     */
    async paymentSnapshot(buyer, sellerAddresses) {
      const balance = await deposits.getBuyerBalance(buyer);
      let sellerUsdc = 0n;
      for (const address of sellerAddresses) sellerUsdc += await usdc.balanceOf(address);
      const recipient = await this.feeRecipient();
      const reserveUsdc = /^0x0{40}$/i.test(recipient) ? 0n : await usdc.balanceOf(recipient);
      return { buyerAvailable: balance.available, buyerReserved: balance.reserved, buyerBalance: balance.available + balance.reserved, sellerUsdc, reserveUsdc };
    },
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
    sendAs(from, method, args) {
      return sendContractAs(from, chain.channelsContractAddress, channelsRead.interface, method, args);
    },
    sendContractAs,
    /**
     * Mints `micros` USDC to `address` on Anvil: MockUSDC's open mint on the local chain, Base USDC's master minter
     * (impersonated, made a minter for exactly this amount) on the fork.
     */
    async mintUsdc(address, micros) {
      const amount = BigInt(micros);
      if (chain.evmChainId === LOCAL_CHAIN_ID) return sendContractAs(LOCAL_DEPLOYER, chain.usdcContractAddress, USDC_ADMIN, 'mint', [address, amount]);
      const masterMinter = await new Contract(chain.usdcContractAddress, USDC_ADMIN, provider).masterMinter();
      await sendContractAs(masterMinter, chain.usdcContractAddress, USDC_ADMIN, 'configureMinter', [masterMinter, amount]);
      return sendContractAs(masterMinter, chain.usdcContractAddress, USDC_ADMIN, 'mint', [address, amount]);
    },
    /** Moves `micros` USDC from `from` to `to` as `from` (impersonated): a transfer from another wallet or an exchange. */
    usdcTransfer(from, to, micros) {
      return sendContractAs(from, chain.usdcContractAddress, USDC_ADMIN, 'transfer', [to, BigInt(micros)]);
    },
    /**
     * The emissions epoch clock: AntseedEmissionsGate's on the recognized-usage stack, the legacy emissions contract's
     * on the payments layout. { epoch, startsAt, endsAt, now } (unix seconds, chain time; endsAt is the next boundary).
     */
    async epochClock() {
      const now = BigInt((await provider.getBlock('latest')).timestamp);
      let genesis;
      let duration;
      if (chain.emissionsGateAddress && (await provider.getCode(chain.emissionsGateAddress)) !== '0x') {
        const gate = new Contract(chain.emissionsGateAddress, ['function genesis() view returns(uint256)', 'function epochDuration() view returns(uint256)'], provider);
        [genesis, duration] = await Promise.all([gate.genesis(), gate.epochDuration()]);
      } else {
        const legacy = new Contract(chain.emissionsContractAddress, ['function genesis() view returns(uint256)', 'function EPOCH_DURATION() view returns(uint256)'], provider);
        [genesis, duration] = await Promise.all([legacy.genesis(), legacy.EPOCH_DURATION()]);
      }
      const epoch = now <= genesis ? 0n : (now - genesis) / duration;
      return { epoch: Number(epoch), startsAt: Number(genesis + epoch * duration), endsAt: Number(genesis + (epoch + 1n) * duration), now: Number(now) };
    },
    /**
     * A staker shares its seller-pool stake with a buyer for staked free-tier allowances: `amountWei` ANTS from the
     * legacy emissions escrow (an ANTS holder on the full local layout and on the fork) are staked by `staker` (a
     * Wallet; every transaction goes out by Anvil impersonation, so it needs no gas or nonce care) in the pool of
     * `agentId` for `epochs`, then `staker` signs the EIP-712 FreeTierDelegation to `buyer` (packages/node
     * free-tier-delegation.ts). Returns the delegation and its shareable code (`antseed buyer free-tier add <code>`).
     * A position counts from the epoch after the stake (seller pools' stakeActivationDelay): warp to the next epoch.
     */
    async delegateFreeTier({ staker, buyer, agentId, amountWei, epochs, expiresAt }) {
      assert(chain.sellerPoolsAddress && (await provider.getCode(chain.sellerPoolsAddress)) !== '0x', 'Free-tier delegations need seller pools: the full local layout or the fork');
      const token = new Contract(chain.antsTokenAddress, ['function owner() view returns(address)', 'function transfersEnabled() view returns(bool)', 'function transferWhitelist(address) view returns(bool)'], provider);
      const tokenAdmin = ['function setTransferWhitelist(address,bool)', 'function transfer(address,uint256) returns(bool)', 'function approve(address,uint256) returns(bool)'];
      const owner = await token.owner();
      const amount = BigInt(amountWei);
      await sendContractAs(chain.legacyEmissionsEscrowAddress, chain.antsTokenAddress, tokenAdmin, 'transfer', [staker.address, amount]);
      const whitelist = !(await token.transfersEnabled()) && !(await token.transferWhitelist(staker.address));
      if (whitelist) await sendContractAs(owner, chain.antsTokenAddress, tokenAdmin, 'setTransferWhitelist', [staker.address, true]);
      let receipt;
      try {
        await sendContractAs(staker.address, chain.antsTokenAddress, tokenAdmin, 'approve', [chain.sellerPoolsAddress, amount]);
        receipt = await sendContractAs(staker.address, chain.sellerPoolsAddress, ['function stake(uint256,uint256,uint256) returns(uint256)'], 'stake', [BigInt(agentId), amount, BigInt(epochs)]);
      } finally {
        if (whitelist) await sendContractAs(owner, chain.antsTokenAddress, tokenAdmin, 'setTransferWhitelist', [staker.address, false]);
      }
      const delegationModule = await import('../../../packages/node/dist/payments/free-tier-delegation.js');
      const message = delegationModule.freeTierDelegationMessage({ staker: staker.address, buyer, expiresAt });
      const signature = await staker.signTypedData(delegationModule.makeFreeTierDelegationDomain(chain.evmChainId), delegationModule.FREE_TIER_DELEGATION_TYPES, message);
      const delegation = { staker: message.staker, buyer: message.buyer, expiresAt, signature };
      return { delegation, code: delegationModule.encodeFreeTierDelegationCode(delegation), stakeTransaction: receipt.hash };
    },
    /** ANTS balance (wei) on the chain's ANTS token, or null when it has none deployed. */
    async antsBalance(address) {
      if (!chain.antsTokenAddress || (await provider.getCode(chain.antsTokenAddress)) === '0x') return null;
      return new Contract(chain.antsTokenAddress, ['function balanceOf(address) view returns(uint256)'], provider).balanceOf(address);
    },
    /** A seller's eligibility and active seller-pool stake through the registry's current staking contract. */
    async sellerStanding(address) {
      const registry = new Contract(chain.registryContractAddress, ['function staking() view returns(address)'], provider);
      const staking = new Contract(await registry.staking(), ['function isStakedAboveMin(address) view returns(bool)', 'function getStake(address) view returns(uint256)', 'function getAgentId(address) view returns(uint256)'], provider);
      const [eligible, stake, agentId] = await Promise.all([staking.isStakedAboveMin(address), staking.getStake(address), staking.getAgentId(address)]);
      return { eligible, stake, agentId: Number(agentId) };
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
