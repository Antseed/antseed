export const WALLET_ERRORS = {
  rejected: 'You rejected the wallet request. This request was not submitted.',
  disconnected: 'The wallet disconnected or no longer permits this request. Reconnect before retrying.',
  network: 'The wallet is on the wrong network. Switch to the dashboard network before retrying.',
  reverted: 'The contract rejected this transaction during wallet simulation. Refresh the position and review its action restrictions.',
  unknown: 'The wallet could not complete the request. Check its activity before retrying; the submission status is unknown.',
};

export function walletFailure(error: unknown): string {
  const seen = new Set<unknown>();
  let current = error;
  let fallback = WALLET_ERRORS.unknown;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const detail = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (detail.code === 4001 || detail.name === 'UserRejectedRequestError') return WALLET_ERRORS.rejected;
    if (detail.code === 4100 || detail.code === 4900 || detail.name === 'ProviderDisconnectedError' || detail.name === 'ConnectorNotConnectedError') return WALLET_ERRORS.disconnected;
    if (detail.code === 4901) return WALLET_ERRORS.network;
    if (detail.name === 'ChainMismatchError' || detail.name === 'SwitchChainError' || detail.name === 'ChainDisconnectedError') fallback = WALLET_ERRORS.network;
    if (detail.name === 'ContractFunctionRevertedError' || detail.name === 'ExecutionRevertedError') fallback = WALLET_ERRORS.reverted;
    current = detail.cause;
  }
  return fallback;
}

export function safeWalletFailure(message: string): string {
  return Object.values(WALLET_ERRORS).includes(message) ? message : WALLET_ERRORS.unknown;
}
