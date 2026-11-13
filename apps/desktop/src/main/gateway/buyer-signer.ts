import { DEFAULT_BUYER_IDENTITY } from '@antseed/node';

/**
 * Whether the local buyer pays from the desktop's signer. `antseed gateway
 * start` attaches to any buyer already on its port, and one started outside
 * the app may hold another wallet; funding the desktop's wallet would then
 * leave the buyer that serves requests unfunded.
 */
export type BuyerSignerCheck = 'match' | 'mismatch' | 'unknown';

/** `GET` a local buyer API route as JSON; null when it doesn't answer, answers an error, or isn't JSON. */
export async function fetchBuyerJson(port: number, pathname: string, timeoutMs: number): Promise<unknown> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

/** The buyer's default identity address (`GET /_antseed/buyer-identities`), or null when it can't be read. */
export async function liveBuyerAddress(buyerPort: number, timeoutMs = 3_000): Promise<string | null> {
  const body = await fetchBuyerJson(buyerPort, '/_antseed/buyer-identities', timeoutMs) as { identities?: Array<{ name?: unknown; address?: unknown }> } | null;
  const entry = body?.identities?.find((identity) => identity.name === DEFAULT_BUYER_IDENTITY);
  return typeof entry?.address === 'string' ? entry.address : null;
}

export function compareBuyerSigner(buyerAddress: string | null, signerAddress: string | null): BuyerSignerCheck {
  if (!buyerAddress || !signerAddress) return 'unknown';
  return buyerAddress.toLowerCase() === signerAddress.toLowerCase() ? 'match' : 'mismatch';
}

export function buyerSignerMismatchMessage(port: number): string {
  return `A buyer started outside this app is running on port ${port} with another wallet, so the local gateway would pay from that wallet, not this app's. Stop that buyer, then reopen the app. Until then the app won't send requests or take deposits through it.`;
}
