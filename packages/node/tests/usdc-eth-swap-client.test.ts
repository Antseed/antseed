import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, type AbstractProvider, type AbstractSigner, type TransactionRequest } from 'ethers';
import { UsdcEthSwapClient, usdcEthSwapDeployment } from '../src/payments/evm/usdc-eth-swap-client.js';
import { getChainConfig } from '../src/payments/chain-config.js';

const baseMainnet = getChainConfig('base-mainnet');
const deployment = baseMainnet.usdcEthSwap!;
const BASE_USDC = baseMainnet.usdcContractAddress;
const BASE_UNISWAP_QUOTER_V2 = deployment.quoterV2;
const BASE_UNISWAP_SWAP_ROUTER_02 = deployment.swapRouter02;
const BASE_WETH = deployment.weth;
const USDC_WETH_POOL_FEE = deployment.poolFee;

const OWNER = '0x1111111111111111111111111111111111111111';
const ROUTER_ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const erc20 = new Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);
const router = new Interface([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(bytes[] data) payable returns (bytes[])',
]);
const quoter = new Interface([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

/**
 * A chain that answers the reads the client makes and records every
 * transaction the signer sends, all mined at once with status 1 (or 0 for `revert`).
 */
function fakeChain(opts: { allowance: bigint; revert?: 'approve' | 'swap' }) {
  const sent: TransactionRequest[] = [];
  const quoterCalls: unknown[] = [];
  const provider = {
    call: async (tx: TransactionRequest) => {
      if (tx.to === BASE_UNISWAP_QUOTER_V2) {
        quoterCalls.push(quoter.decodeFunctionData('quoteExactInputSingle', tx.data!)[0]);
        return AbiCoder.defaultAbiCoder().encode(['uint256', 'uint160', 'uint32', 'uint256'], [4_466_738_954_364_848n, 0n, 1, 90_000n]);
      }
      const { name, args } = erc20.parseTransaction({ data: tx.data! })!;
      if (name === 'allowance') {
        expect([args[0], args[1]]).toEqual([OWNER, BASE_UNISWAP_SWAP_ROUTER_02]);
        return erc20.encodeFunctionResult('allowance', [opts.allowance]);
      }
      return erc20.encodeFunctionResult('balanceOf', [25_000_000n]);
    },
    getTransactionCount: async () => 7,
    getBlock: async () => ({ baseFeePerGas: 5_000_000n }),
    _perform: async () => '0xf4240',
    getTransactionReceipt: async (hash: string) => {
      const index = Number(hash.slice(-1));
      const kind = sent[index]!.to === BASE_USDC ? 'approve' : 'swap';
      return { hash, status: opts.revert === kind ? 0 : 1, to: sent[index]!.to, from: OWNER };
    },
  } as unknown as AbstractProvider;
  const signer = {
    provider,
    getAddress: async () => OWNER,
    estimateGas: async () => 100_000n,
    sendTransaction: async (tx: TransactionRequest) => {
      sent.push({ ...tx });
      return { hash: `0x${'ab'.repeat(31)}0${sent.length - 1}`, from: OWNER, nonce: tx.nonce };
    },
  } as unknown as AbstractSigner;
  const client = new UsdcEthSwapClient({ rpcUrl: 'http://127.0.0.1:1', evmChainId: 8453, usdcAddress: BASE_USDC, deployment }).withProvider(provider);
  return { client, signer, sent, quoterCalls };
}

function decodeSwap(tx: TransactionRequest) {
  expect(tx.to).toBe(BASE_UNISWAP_SWAP_ROUTER_02);
  const [calls] = router.decodeFunctionData('multicall', tx.data!) as unknown as [string[]];
  const swap = router.parseTransaction({ data: calls[0]! })!;
  const unwrap = router.parseTransaction({ data: calls[1]! })!;
  expect([calls.length, swap.name, unwrap.name]).toEqual([2, 'exactInputSingle', 'unwrapWETH9']);
  const [tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96] = swap.args[0] as unknown as unknown[];
  return { tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96, unwrapMin: unwrap.args[0], unwrapTo: unwrap.args[1] };
}

describe('UsdcEthSwapClient', () => {
  it('takes the Base mainnet Uniswap v3 USDC/WETH 0.05% deployment from chain config', () => {
    expect(deployment).toEqual({
      swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481',
      quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
      weth: '0x4200000000000000000000000000000000000006',
      poolFee: 500,
    });
  });

  it('is available only on a chain with a swap deployment, for its canonical USDC', () => {
    expect(usdcEthSwapDeployment(baseMainnet, { evmChainId: 8453, usdcAddress: BASE_USDC.toLowerCase() })).toBe(deployment);
    expect(usdcEthSwapDeployment(baseMainnet, { evmChainId: 84532, usdcAddress: BASE_USDC })).toBeNull();
    expect(usdcEthSwapDeployment(baseMainnet, { evmChainId: 8453, usdcAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3' })).toBeNull();
    const sepolia = getChainConfig('base-sepolia');
    expect(usdcEthSwapDeployment(sepolia, { evmChainId: sepolia.evmChainId, usdcAddress: sepolia.usdcContractAddress })).toBeNull();
  });

  it('quotes USDC → WETH on the 0.05% pool', async () => {
    const { client, quoterCalls } = fakeChain({ allowance: 0n });
    expect(await client.quote(10_000_000n)).toBe(4_466_738_954_364_848n);
    expect(quoterCalls).toEqual([[BASE_USDC, BASE_WETH, 10_000_000n, BigInt(USDC_WETH_POOL_FEE), 0n]]);
  });

  it('approves the router for exactly the amount, then swaps to the router and unwraps to the wallet, on consecutive nonces', async () => {
    const { client, signer, sent } = fakeChain({ allowance: 0n });
    const hash = await client.swapUsdcForEth(signer, 10_000_000n, 4_400_000_000_000_000n);
    expect(sent).toHaveLength(2);
    const [approve, swap] = sent as [TransactionRequest, TransactionRequest];
    expect(approve.to).toBe(BASE_USDC);
    expect(erc20.decodeFunctionData('approve', approve.data!)).toEqual([BASE_UNISWAP_SWAP_ROUTER_02, 10_000_000n]);
    expect(decodeSwap(swap)).toEqual({
      tokenIn: BASE_USDC, tokenOut: BASE_WETH, fee: BigInt(USDC_WETH_POOL_FEE), recipient: ROUTER_ADDRESS_THIS,
      amountIn: 10_000_000n, amountOutMinimum: 4_400_000_000_000_000n, sqrtPriceLimitX96: 0n,
      unwrapMin: 4_400_000_000_000_000n, unwrapTo: OWNER,
    });
    // No ETH is sent with the swap; gas is buffered over the estimate and priced from the base fee.
    expect(swap.value ?? 0n).toBe(0n);
    expect([approve.nonce, swap.nonce]).toEqual([7, 8]);
    expect(swap.gasLimit).toBe(130_000n);
    expect(swap.maxFeePerGas).toBe(5_000_000n * 2n + 1_000_000n);
    expect(hash.endsWith('01')).toBe(true);
  });

  it('skips the approval when the router may already spend the amount', async () => {
    const { client, signer, sent } = fakeChain({ allowance: 10_000_000n });
    await client.swapUsdcForEth(signer, 10_000_000n, 1n);
    expect(sent).toHaveLength(1);
    expect(decodeSwap(sent[0]!).amountIn).toBe(10_000_000n);
  });

  it('throws when the swap reverts (e.g. the price moved past the slippage limit)', async () => {
    const { client, signer } = fakeChain({ allowance: 10_000_000n, revert: 'swap' });
    await expect(client.swapUsdcForEth(signer, 10_000_000n, 1n)).rejects.toMatchObject({ code: 'CALL_EXCEPTION' });
  });

  it('bounds a swap\'s cost at 300k gas at the current max fee', async () => {
    const { client } = fakeChain({ allowance: 0n });
    expect(await client.maxSwapCostWei()).toBe(300_000n * (5_000_000n * 2n + 1_000_000n));
  });
});
