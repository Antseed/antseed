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
 * The pay page's link rules (its `parseLink`): `amount` is required, whole
 * dollars or up to two decimals, and between $1 and $200. A link outside
 * these bounds — including one with no amount at all — is refused as
 * "invalid or was altered" before the signature is even checked.
 */
export const ANTSEED_PAY_MIN_USD = 1;
export const ANTSEED_PAY_MAX_USD = 200;
const ANTSEED_PAY_AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
/** Opened when the caller has no amount; the user can change it on the page. */
export const ANTSEED_PAY_DEFAULT_AMOUNT = '20';

/**
 * The amount as the page accepts it, or null when the page would refuse the
 * link. Takes the desktop's `String(Number(input))` form and user input
 * ("10.50" → "10.5"); '' and other non-amounts are null.
 */
export function antseedPayAmount(input: unknown): string | null {
  let amount = Number.NaN;
  if (typeof input === 'number') amount = input;
  else if (typeof input === 'string' && input.trim() !== '') amount = Number(input);
  if (!Number.isFinite(amount) || amount < ANTSEED_PAY_MIN_USD || amount > ANTSEED_PAY_MAX_USD) return null;
  const text = String(amount);
  return ANTSEED_PAY_AMOUNT_RE.test(text) ? text : null;
}

/**
 * The amount a funding link opens on: the caller's when the page accepts it,
 * else `ANTSEED_PAY_DEFAULT_AMOUNT`. The page refuses an empty amount, so a
 * link is never signed without one.
 */
export function antseedPayLinkAmount(input: unknown): string {
  return antseedPayAmount(input) ?? ANTSEED_PAY_DEFAULT_AMOUNT;
}

/**
 * The signed message. Its header is a wire-format constant matching the pay
 * page's `buildFundingMessage` byte for byte ("AntSeed Pay", capital S) — not
 * display copy, so it must not follow product-name renames. The address is
 * lowercased (verified against the reference sig the page accepts); the URL
 * param stays checksummed. `amount` must be one the page accepts (see
 * `antseedPayAmount`): the page signs the same string it reads from the URL.
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
 * Adds the Antseed Pay params to `url` in place: address, currency, amount,
 * the wallet's signature over `antseedPayMessage`, and the integration to
 * open (unsigned, UX only). Throws when `amount` is one the page refuses
 * (empty, more than two decimals, or outside $1–$200): the link would open
 * to "invalid or was altered", so callers pass `antseedPayLinkAmount(...)`.
 */
export async function signAntseedPayUrl(url: URL, input: {
  wallet: { address: string; signMessage(message: string): Promise<string> };
  amount: string;
  integration: AntseedPayIntegration;
}): Promise<URL> {
  const { wallet, amount, integration } = input;
  if (antseedPayAmount(amount) !== amount) {
    throw new Error(`Antseed Pay amount must be $${ANTSEED_PAY_MIN_USD}–$${ANTSEED_PAY_MAX_USD} with at most 2 decimals`);
  }
  url.searchParams.set('address', wallet.address);
  url.searchParams.set('cur', ANTSEED_PAY_CURRENCY);
  url.searchParams.set('amount', amount);
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
