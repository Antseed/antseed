import { describe, expect, it } from 'vitest';
import { safeWalletFailure, walletFailure, WALLET_ERRORS } from './wallet-errors.js';

describe('safe wallet failures', () => {
  it.each([
    [{ code: 4001 }, WALLET_ERRORS.rejected],
    [{ name: 'TransactionExecutionError', cause: { code: 4001 } }, WALLET_ERRORS.rejected],
    [{ name: 'SwitchChainError', cause: { code: 4001 } }, WALLET_ERRORS.rejected],
    [{ name: 'UserRejectedRequestError' }, WALLET_ERRORS.rejected],
    [{ code: 4100 }, WALLET_ERRORS.disconnected],
    [{ code: 4900 }, WALLET_ERRORS.disconnected],
    [{ code: 4901 }, WALLET_ERRORS.network],
    [{ name: 'ChainMismatchError' }, WALLET_ERRORS.network],
    [{ cause: { name: 'ContractFunctionRevertedError' } }, WALLET_ERRORS.reverted],
    [new Error('RPC failed with a secret URL'), WALLET_ERRORS.unknown],
  ])('classifies %j without exposing raw wallet data', (error, expected) => {
    expect(walletFailure(error)).toBe(expected);
    expect(safeWalletFailure(walletFailure(error))).toBe(expected);
  });

  it('does not echo arbitrary client messages or loop on circular causes', () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(walletFailure(error)).toBe(WALLET_ERRORS.unknown);
    expect(safeWalletFailure('https://private-rpc.example/secret')).toBe(WALLET_ERRORS.unknown);
  });
});
