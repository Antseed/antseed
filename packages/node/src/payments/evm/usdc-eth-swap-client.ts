import { Contract, getBigInt } from 'ethers';
import type { AbstractSigner } from 'ethers';
import { BaseEvmClient, ERC20_ABI } from './base-evm-client.js';
import type { ChainConfig, UsdcEthSwapDeployment } from '../chain-config.js';

/**
 * Gas for the approve + swap pair, rounded up. Used only to decide whether the
 * wallet can still pay for a swap; each tx is estimated before it is sent.
 */
export const SWAP_GAS_UNITS = 300_000n;

/** SwapRouter02's `ADDRESS_THIS`: the swap output stays in the router so it can be unwrapped. */
const ROUTER_ADDRESS_THIS = '0x0000000000000000000000000000000000000002';

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(bytes[] data) payable returns (bytes[])',
] as const;

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
] as const;

export interface UsdcEthSwapClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  evmChainId?: number;
  usdcAddress: string;
  deployment: UsdcEthSwapDeployment;
}

/**
 * The chain's USDC→ETH swap deployment, or null when automatic swaps are not
 * available: the chain lists none (only Base mainnet does), or the seller's
 * configured chain id or USDC is not the one the deployment's pool trades.
 */
export function usdcEthSwapDeployment(
  chain: Pick<ChainConfig, 'evmChainId' | 'usdcContractAddress' | 'usdcEthSwap'>,
  seller: { evmChainId: number; usdcAddress: string },
): UsdcEthSwapDeployment | null {
  if (!chain.usdcEthSwap || seller.evmChainId !== chain.evmChainId) return null;
  return seller.usdcAddress.toLowerCase() === chain.usdcContractAddress.toLowerCase() ? chain.usdcEthSwap : null;
}

/**
 * Swaps the seller wallet's USDC for native ETH on Uniswap v3, paying gas in
 * ETH like every other seller write (shared nonce lock, fee and gas buffer).
 */
export class UsdcEthSwapClient extends BaseEvmClient {
  private readonly _usdcAddress: string;
  private readonly _deployment: UsdcEthSwapDeployment;

  constructor(config: UsdcEthSwapClientConfig) {
    super(config.rpcUrl, config.deployment.swapRouter02, config.fallbackRpcUrls, config.evmChainId);
    this._usdcAddress = config.usdcAddress;
    this._deployment = config.deployment;
  }

  /** Expected ETH (wei) for `amountIn` USDC base units at the current pool price. */
  async quote(amountIn: bigint): Promise<bigint> {
    const { quoterV2, weth, poolFee } = this._deployment;
    const quoter = new Contract(quoterV2, QUOTER_ABI, this._provider);
    const [amountOut] = await quoter.getFunction('quoteExactInputSingle').staticCall([
      this._usdcAddress, weth, amountIn, poolFee, 0n,
    ]) as [bigint];
    return getBigInt(amountOut);
  }

  async usdcBalance(address: string): Promise<bigint> {
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, this._provider);
    return getBigInt(await usdc.getFunction('balanceOf').staticCall(address));
  }

  /** Upper bound on what an approve + swap costs at the current fees. */
  async maxSwapCostWei(): Promise<bigint> {
    const fees = await this._feeFields();
    const maxFeePerGas = fees.maxFeePerGas == null ? (await this._provider.getFeeData()).maxFeePerGas : getBigInt(fees.maxFeePerGas);
    if (maxFeePerGas == null) throw new Error('cannot read gas fees');
    return SWAP_GAS_UNITS * maxFeePerGas;
  }

  /**
   * Swap `amountIn` USDC for at least `minEthOut` wei, delivered as native ETH
   * to the signer. Approves the router for exactly `amountIn` first when the
   * current allowance is short. Returns the swap tx hash.
   */
  async swapUsdcForEth(signer: AbstractSigner, amountIn: bigint, minEthOut: bigint): Promise<string> {
    const owner = await signer.getAddress();
    const { swapRouter02, weth, poolFee } = this._deployment;
    const router = new Contract(swapRouter02, ROUTER_ABI);
    const calls = [
      router.interface.encodeFunctionData('exactInputSingle', [[
        this._usdcAddress, weth, poolFee, ROUTER_ADDRESS_THIS, amountIn, minEthOut, 0n,
      ]]),
      router.interface.encodeFunctionData('unwrapWETH9', [minEthOut, owner]),
    ];
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, this._provider);
    const allowance = getBigInt(await usdc.getFunction('allowance').staticCall(owner, swapRouter02));
    if (allowance >= amountIn) return this._execWrite(signer, ROUTER_ABI, 'multicall', calls);
    return this._approveAndExec(signer, this._usdcAddress, amountIn, ROUTER_ABI, 'multicall', calls);
  }
}
