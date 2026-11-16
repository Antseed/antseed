import { Contract, Interface, TypedDataEncoder } from 'ethers';
import type { AbstractSigner, TypedDataDomain } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface DepositRelayClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
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

/** Conservative ETH/USD assumption for profitability checks when the caller
 *  provides no price. Overestimating ETH makes the check stricter, never
 *  unprofitable-but-accepted. */
const DEFAULT_ETH_PRICE_USD = 10_000n;

const DEPOSIT_RELAY_ABI = [
  'function sweepDeposit(address from, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes sig3009) external',
  'function FEE() external view returns (uint256)',
  'function usdc() external view returns (address)',
  'function deposits() external view returns (address)',
  'event SweepExecuted(address indexed buyer, address indexed relayer, uint256 deposited, uint256 fee, bytes32 authNonce)',
] as const;

const DEPOSIT_RELAY_INTERFACE = new Interface(DEPOSIT_RELAY_ABI);

export class DepositRelayClient extends BaseEvmClient {
  constructor(config: DepositRelayClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
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
    const [gasEstimate, feeData, fee] = await Promise.all([
      connected.estimateGas(populated),
      this._provider.getFeeData(),
      this.fee(),
    ]);

    const gasPriceWei = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const ethPriceUsd = opts?.ethPriceUsd ?? DEFAULT_ETH_PRICE_USD;
    // wei * usd/eth → USDC base units (6 decimals): / 1e18 * 1e6 = / 1e12
    const estGasCostUsdc = (gasEstimate * gasPriceWei * ethPriceUsd) / 10n ** 12n;

    const budgetUsdc = fee - (opts?.minProfitUsdc ?? 0n);
    const maxFeePerGasWei = budgetUsdc > 0n && gasEstimate > 0n ? (budgetUsdc * 10n ** 12n) / (gasEstimate * ethPriceUsd) : 0n;

    return { gasEstimate, estGasCostUsdc, fee, profitUsdc: fee - estGasCostUsdc, maxFeePerGasWei };
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
