export async function waitForLocalReceipt(provider, transaction, {
  timeoutMs = 120_000,
  pollIntervalMs = 50,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const receipt = await provider.getTransactionReceipt(transaction.hash);
    if (receipt !== null) {
      if (receipt.status !== 1) throw new Error(`local transaction reverted: ${transaction.hash}`);
      return receipt;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for local transaction receipt: ${transaction.hash}`);
}
