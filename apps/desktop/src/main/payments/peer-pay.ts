import { randomUUID } from 'node:crypto';
import { asRecord } from '../utils.js';

const PEER_PAY_REQUEST_TIMEOUT_MS = 8000;
const USDC_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;

type CreatePeerPayCheckoutInput = {
  readonly endpoint: string;
  readonly address: string;
  readonly amount: string;
};

type CheckoutSigner = {
  signMessage(message: string): Promise<string>;
};

type CreatePeerPayCheckoutDependencies = {
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly createNonce?: () => string;
};

type CheckoutAuthorization = {
  readonly address: string;
  readonly amount: string;
  readonly timestamp: string;
  readonly nonce: string;
};

export function buildCheckoutAuthorizationMessage(
  authorization: CheckoutAuthorization,
): string {
  return [
    'AntSeed Peer Pay Checkout',
    'version: 1',
    'audience: antseed-checkout.pay.zkp2p.xyz',
    'method: POST',
    'path: /api/checkout',
    `address: ${authorization.address.toLowerCase()}`,
    `amount: ${authorization.amount}`,
    `timestamp: ${authorization.timestamp}`,
    `nonce: ${authorization.nonce}`,
  ].join('\n');
}

function parseSecureUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(`${label} URL must be https`);
  }
  return url;
}

export async function createPeerPayCheckout(
  input: CreatePeerPayCheckoutInput,
  signer: CheckoutSigner,
  dependencies: CreatePeerPayCheckoutDependencies = {},
): Promise<string> {
  const endpoint = parseSecureUrl(input.endpoint, 'Peer Pay endpoint');
  if (
    typeof input.amount !== 'string'
    || !USDC_AMOUNT_PATTERN.test(input.amount)
    || /^0(?:\.0+)?$/.test(input.amount)
  ) {
    throw new Error('Enter a positive USDC amount with at most 6 decimal places');
  }
  const authorization = {
    address: input.address,
    amount: input.amount,
    timestamp: String(Math.floor((dependencies.now ?? Date.now)() / 1000)),
    nonce: (dependencies.createNonce ?? randomUUID)(),
  };
  const signature = await signer.signMessage(
    buildCheckoutAuthorizationMessage(authorization),
  );
  const fetcher = dependencies.fetcher ?? fetch;
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...authorization,
      signature,
    }),
    signal: AbortSignal.timeout(PEER_PAY_REQUEST_TIMEOUT_MS),
  });
  const body = asRecord(await response.json());
  if (!response.ok) {
    const message = asRecord(body.error).message;
    throw new Error(typeof message === 'string' ? message : `Peer Pay checkout failed with status ${response.status}`);
  }

  const checkoutUrlValue = body.checkoutUrl;
  if (typeof checkoutUrlValue !== 'string' || checkoutUrlValue === '') {
    throw new Error('Peer Pay checkout response is missing checkoutUrl');
  }
  const checkoutUrl = parseSecureUrl(checkoutUrlValue, 'Peer Pay checkout');
  return checkoutUrl.toString();
}
