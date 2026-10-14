/**
 * Signed Antseed Pay funding links (card checkout), shared by the desktop
 * (`payments:open-card-provider`) and the gateway console
 * (`POST /workspaces/:id/wallet/card-link`) so both build the same bytes.
 *
 * The pay page checks a personal-sign signature over a canonical message
 * naming the buyer address, currency and amount, proving the params came
 * from that wallet. Pure and dependency-free: import it as
 * `@antseed/payments/card-link` without loading the payments server.
 */

/** The pay page's integrations; the `provider` URL param opens exactly one. */
export type AntseedPayIntegration = 'crossmint' | 'stripe';

export const ANTSEED_PAY_INTEGRATIONS: readonly AntseedPayIntegration[] = ['crossmint', 'stripe'];

export const DEFAULT_ANTSEED_PAY_URL = 'https://antseed-pay.com/';

const ANTSEED_PAY_CURRENCY = 'USD';

/**
 * The signed message. Its header is a wire-format constant matching the pay
 * page's `buildFundingMessage` byte for byte ("AntSeed Pay", capital S) — not
 * display copy, so it must not follow product-name renames. The address is
 * lowercased (verified against the reference sig the page accepts); the URL
 * param stays checksummed. `amount` is '' when none was entered.
 */
export function antseedPayMessage(address: string, amount: string): string {
  return [
    'AntSeed Pay',
    `address: ${address.toLowerCase()}`,
    `currency: ${ANTSEED_PAY_CURRENCY}`,
    `amount: ${amount}`,
  ].join('\n');
}

/**
 * Expands a provider URL template (`{address}`, optional `{amount}`) and
 * checks it: https only, except loopback so a locally run pay page can be
 * tested. With no amount (''), query params still carrying the `{amount}`
 * placeholder are dropped. Throws 'Card provider URL is invalid' / '... must
 * be https'.
 */
export function resolveCardProviderUrl(template: string, address: string, amount: string): URL {
  let expanded = template.split('{address}').join(address);
  if (amount) expanded = expanded.split('{amount}').join(amount);
  let parsed: URL;
  try {
    parsed = new URL(expanded);
  } catch {
    throw new Error('Card provider URL is invalid');
  }
  const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error('Card provider URL must be https');
  }
  if (!amount) {
    for (const [key, value] of [...parsed.searchParams.entries()]) {
      if (value.includes('{amount}')) parsed.searchParams.delete(key);
    }
  }
  return parsed;
}

/**
 * Adds the Antseed Pay params to `url` in place: address, currency, amount
 * (when given), the wallet's signature over `antseedPayMessage`, and the
 * integration to open (unsigned, UX only).
 */
export async function signAntseedPayUrl(url: URL, input: {
  wallet: { address: string; signMessage(message: string): Promise<string> };
  amount: string;
  integration: AntseedPayIntegration;
}): Promise<URL> {
  const { wallet, amount, integration } = input;
  url.searchParams.set('address', wallet.address);
  url.searchParams.set('cur', ANTSEED_PAY_CURRENCY);
  if (amount) url.searchParams.set('amount', amount);
  url.searchParams.set('sig', await wallet.signMessage(antseedPayMessage(wallet.address, amount)));
  url.searchParams.set('provider', integration);
  return url;
}

/** The full signed link for a pay-page base URL (or template). */
export async function buildAntseedPayLink(input: {
  baseUrl: string;
  wallet: { address: string; signMessage(message: string): Promise<string> };
  amount: string;
  integration: AntseedPayIntegration;
}): Promise<string> {
  const url = resolveCardProviderUrl(input.baseUrl, input.wallet.address, input.amount);
  return (await signAntseedPayUrl(url, input)).toString();
}
