import { Contract, Interface, TypedDataEncoder, getBigInt } from 'ethers';
import type { AbstractSigner, TypedDataDomain } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
import { debugLog } from '../../utils/debug.js';

export interface DepositRelayClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
  /** Chainlink ETH/USD aggregator the profit estimate reads (chain-config `ethUsdPriceFeedAddress`). */
  ethUsdPriceFeedAddress?: string;
}

export interface SweepParams {
  from: string;
  amount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: string; // bytes32 hex
  sig3009: string;
}

export interface SweepProfitEstimate {
  gasEstimate: bigint;
  /** Expected price per gas: the latest base fee plus 25%, plus the tip the sweep would send. */
  gasPriceWei: bigint;
  /** ETH/USD the cost was converted at, with 8 decimals. */
  ethPriceUsdE8: bigint;
  /** Estimated gas cost converted to USDC base units (6 decimals). */
  estGasCostUsdc: bigint;
  /** The contract's fixed FEE the relayer earns. */
  fee: bigint;
  /** fee - estGasCostUsdc; negative when relaying costs more than it pays. */
  profitUsdc: bigint;
  /** Highest max fee per gas at which the sweep still earns `minProfitUsdc` (the estimate's option). */
  maxFeePerGasWei: bigint;
}

export interface SweepEventConfirmation {
  txHash: string;
  blockNumber: number;
  buyer: string;
  relayer: string;
  deposited: bigint;
  fee: bigint;
  authNonce: string;
}

const USD_E8 = 10n ** 8n;
/**
 * ETH/USD when neither the caller nor a fresh Chainlink reading gives one: the fixed price the
 * estimate used before it read the feed. It sits well above where ETH trades, so without a price
 * the check is stricter (a sweep refused that would have paid), never a sweep accepted at a loss.
 */
const FALLBACK_ETH_PRICE_USD_E8 = 10_000n * USD_E8;
/** A Chainlink answer older than this, against the latest block's timestamp, is not used. */
const ETH_PRICE_FEED_MAX_AGE_SECS = 2n * 60n * 60n;
/** Headroom over the latest base fee for it rising while the sweep waits. */
const BASE_FEE_MARGIN_NUM = 5n;
const BASE_FEE_MARGIN_DEN = 4n;
/** wei x USD/ETH (8 decimals) → USDC base units (6 decimals): / 1e18 / 1e8 * 1e6. */
const WEI_USD_E8_TO_USDC = 10n ** 20n;

/** Chainlink aggregator; ETH/USD answers with 8 decimals. */
const CHAINLINK_AGGREGATOR_ABI = [
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
] as const;

const DEPOSIT_RELAY_ABI = [
  'function sweepDeposit(address from, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes sig3009) external',
  'function FEE() external view returns (uint256)',
  'function usdc() external view returns (address)',
  'function deposits() external view returns (address)',
  'event SweepExecuted(address indexed buyer, address indexed relayer, uint256 deposited, uint256 fee, bytes32 authNonce)',
] as const;

const DEPOSIT_RELAY_INTERFACE = new Interface(DEPOSIT_RELAY_ABI);

export class DepositRelayClient extends BaseEvmClient {
  private readonly _ethUsdPriceFeedAddress: string | null;

  constructor(config: DepositRelayClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
    this._ethUsdPriceFeedAddress = config.ethUsdPriceFeedAddress ?? null;
  }

  // ─── Relayer Operations ────────────────────────────────────────────

  /** `opts.maxFeePerGasWei` caps what speeding up a stalled sweep may pay (see `estimateSweepProfit`). */
  async sweep(signer: AbstractSigner, params: SweepParams, opts?: { maxFeePerGasWei?: bigint }): Promise<string> {
    return this._execWriteWithin(
      signer,
      opts?.maxFeePerGasWei ?? null,
      DEPOSIT_RELAY_ABI,
      'sweepDeposit',
      params.from,
      params.amount,
      params.validAfter,
      params.validBefore,
      params.nonce,
      params.sig3009,
    );
  }

  /**
   * Simulate the sweep and estimate the relayer's profit against the fixed
   * FEE. Throws if the simulation reverts (bad signature, used nonce, expired
   * window, min-deposit violation, ...) — callers should treat a throw as
   * "do not relay".
   *
   * The cost is what the sweep is expected to pay: the latest base fee plus 25% and the tip the
   * sweep would send, at `opts.ethPriceUsd`, else the Chainlink ETH/USD feed, else a cautious
   * constant. `maxFeePerGasWei` is the gas price at which the fee no longer covers the gas.
   * Base's L1 data fee is not counted. It is usually a small fraction of a cent for a sweep, but a
   * sweep within that much of break-even can lose it at `minProfitUsdc` 0.
   */
  async estimateSweepProfit(
    signer: AbstractSigner,
    params: SweepParams,
    opts?: { ethPriceUsd?: bigint; minProfitUsdc?: bigint },
  ): Promise<SweepProfitEstimate> {
    const connected = this._ensureConnected(signer);
    const contract = new Contract(this._contractAddress, DEPOSIT_RELAY_ABI, connected);
    const populated = await contract.getFunction('sweepDeposit').populateTransaction(
      params.from,
      params.amount,
      params.validAfter,
      params.validBefore,
      params.nonce,
      params.sig3009,
    );
    const [gasEstimate, block, feeFields, fee] = await Promise.all([
      connected.estimateGas(populated),
      this._provider.getBlock('latest'),
      // The tip the sweep itself would send (see BaseEvmClient._feeFields).
      this._feeFields(),
      this.fee(),
    ]);

    const baseFee = block?.baseFeePerGas;
    if (!block || baseFee == null) throw new Error('cannot read the base fee to price the sweep');
    const gasPriceWei = (baseFee * BASE_FEE_MARGIN_NUM) / BASE_FEE_MARGIN_DEN + getBigInt(feeFields.maxPriorityFeePerGas ?? 0);
    const ethPriceUsdE8 = await this._ethPriceUsdE8(opts?.ethPriceUsd, block.timestamp);
    const estGasCostUsdc = (gasEstimate * gasPriceWei * ethPriceUsdE8) / WEI_USD_E8_TO_USDC;

    const budgetUsdc = fee - (opts?.minProfitUsdc ?? 0n);
    const maxFeePerGasWei = budgetUsdc > 0n && gasEstimate > 0n
      ? (budgetUsdc * WEI_USD_E8_TO_USDC) / (gasEstimate * ethPriceUsdE8)
      : 0n;

    return {
      gasEstimate,
      gasPriceWei,
      ethPriceUsdE8,
      estGasCostUsdc,
      fee,
      profitUsdc: fee - estGasCostUsdc,
      maxFeePerGasWei,
    };
  }

  /** ETH/USD with 8 decimals: the override, else a fresh positive Chainlink answer, else the fallback. */
  private async _ethPriceUsdE8(overrideUsd: bigint | undefined, blockTimestamp: number): Promise<bigint> {
    if (overrideUsd !== undefined && overrideUsd > 0n) return overrideUsd * USD_E8;
    if (this._ethUsdPriceFeedAddress) {
      try {
        const feed = new Contract(this._ethUsdPriceFeedAddress, CHAINLINK_AGGREGATOR_ABI, this._provider);
        const round = await feed.getFunction('latestRoundData')();
        const answer = getBigInt(round.answer);
        const age = BigInt(blockTimestamp) - getBigInt(round.updatedAt);
        if (answer > 0n && age <= ETH_PRICE_FEED_MAX_AGE_SECS) return answer;
        debugLog(`[Relayer] ETH/USD feed unusable (answer=${answer}, age=${age}s); using the fallback price`);
      } catch (err) {
        debugLog(`[Relayer] ETH/USD feed read failed: ${err instanceof Error ? err.message : String(err)}; using the fallback price`);
      }
    }
    return FALLBACK_ETH_PRICE_USD_E8;
  }

  // ─── View Functions ─────────────────────────────────────────────────

  /** The contract's fixed, immutable relayer fee in USDC base units. */
  async fee(): Promise<bigint> {
    const contract = new Contract(this._contractAddress, DEPOSIT_RELAY_ABI, this._provider);
    return contract.getFunction('FEE')() as Promise<bigint>;
  }

  /**
   * Confirm a relayer-reported transaction by reading its receipt and matching
   * the relay's SweepExecuted event against the buyer authorization nonce.
   */
  async getSweepConfirmation(
    txHash: string,
    expected?: {
      buyer?: string;
      deposited?: bigint;
      fee?: bigint;
      authNonce?: string;
    },
  ): Promise<SweepEventConfirmation | null> {
    const receipt = await this._provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) return null;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this._contractAddress.toLowerCase()) continue;
      const parsed = (() => {
        try {
          return DEPOSIT_RELAY_INTERFACE.parseLog(log);
        } catch {
          return null;
        }
      })();
      if (!parsed || parsed.name !== 'SweepExecuted') continue;
      const args = parsed.args as unknown as {
        buyer: string;
        relayer: string;
        deposited: bigint;
        fee: bigint;
        authNonce: string;
      };
      if (expected?.buyer && args.buyer.toLowerCase() !== expected.buyer.toLowerCase()) continue;
      if (expected?.deposited !== undefined && args.deposited !== expected.deposited) continue;
      if (expected?.fee !== undefined && args.fee !== expected.fee) continue;
      if (expected?.authNonce && args.authNonce.toLowerCase() !== expected.authNonce.toLowerCase()) continue;
      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        buyer: args.buyer,
        relayer: args.relayer,
        deposited: args.deposited,
        fee: args.fee,
        authNonce: args.authNonce,
      };
    }

    return null;
  }

  /**
   * Check whether USDC has consumed the EIP-3009 authorization nonce. Because
   * sweep authorizations are signed with `to = AntseedDepositRelay`, and the
   * relay call is atomic, a consumed nonce is a strong fallback confirmation
   * that the sweep transaction landed even when no relayer tx hash was reported.
   */
  async isAuthorizationUsed(usdcAddress: string, from: string, nonce: string): Promise<boolean> {
    const usdc = new Contract(
      usdcAddress,
      ['function authorizationState(address authorizer, bytes32 nonce) external view returns (bool)'],
      this._provider,
    );
    return usdc.getFunction('authorizationState')(from, nonce) as Promise<boolean>;
  }

  /**
   * Compare a locally computed EIP-712 domain against the deployed USDC
   * token's DOMAIN_SEPARATOR(). Circle's domain params (name/version) vary by
   * deployment — call this before signing EIP-3009 authorizations so a
   * mismatch fails loudly instead of producing signatures the token rejects.
   */
  async verifyUsdcDomain(usdcAddress: string, domain: TypedDataDomain): Promise<boolean> {
    const usdc = new Contract(
      usdcAddress,
      ['function DOMAIN_SEPARATOR() external view returns (bytes32)'],
      this._provider,
    );
    const onChain = await usdc.getFunction('DOMAIN_SEPARATOR')() as string;
    return onChain.toLowerCase() === TypedDataEncoder.hashDomain(domain).toLowerCase();
  }
}
