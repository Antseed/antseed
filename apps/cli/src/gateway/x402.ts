import { getAddress, verifyTypedData } from 'ethers'

/**
 * x402 v2 over HTTP, `exact` scheme with EIP-3009 USDC transfers: the
 * gateway names a payee and amount in `PAYMENT-REQUIRED`, the client signs a
 * `transferWithAuthorization` and sends it as `PAYMENT-SIGNATURE`, and a
 * facilitator settles it on-chain. See https://github.com/coinbase/x402.
 */
export const X402_VERSION = 2
export const PAYMENT_REQUIRED_HEADER = 'payment-required'
export const PAYMENT_SIGNATURE_HEADER = 'payment-signature'
export const PAYMENT_RESPONSE_HEADER = 'payment-response'

const DEFAULT_MAX_TIMEOUT_SECONDS = 300

export interface X402Asset {
  /** CAIP-2 network id, e.g. `eip155:8453` for Base. */
  network: string
  chainId: number
  /** USDC contract address. */
  address: string
  /** EIP-712 domain of the token, as `transferWithAuthorization` checks it. */
  name: string
  version: string
}

export interface PaymentRequirements {
  scheme: 'exact'
  network: string
  amount: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
  extra: { assetTransferMethod: 'eip3009'; name: string; version: string }
}

export interface PaymentRequired {
  x402Version: number
  error?: string
  resource: { url: string; description: string; mimeType: string }
  accepts: PaymentRequirements[]
}

export interface Eip3009Authorization {
  from: string
  to: string
  value: string
  validAfter: string
  validBefore: string
  nonce: string
}

export interface PaymentPayload {
  x402Version: number
  resource?: PaymentRequired['resource']
  accepted: PaymentRequirements
  payload: { signature: string; authorization: Eip3009Authorization }
}

export interface SettlementResponse {
  success: boolean
  transaction: string
  network: string
  payer: string
  errorReason?: string
}

export function encodeHeaderJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

export function decodeHeaderJson<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T
  } catch {
    return null
  }
}

export function buildPaymentRequirements(asset: X402Asset, payTo: string, amountUsdc: number): PaymentRequirements {
  return {
    scheme: 'exact',
    network: asset.network,
    amount: String(amountUsdc),
    asset: asset.address,
    payTo: getAddress(payTo),
    maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
    extra: { assetTransferMethod: 'eip3009', name: asset.name, version: asset.version },
  }
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Checks the gateway can make before asking a facilitator: the payment pays
 * exactly what was asked, to the key's wallet, inside its validity window,
 * and is signed by the payer it names. Balance and nonce use are left to the
 * facilitator's on-chain simulation. Returns an x402 error reason, or null.
 */
export function checkPaymentPayload(
  payment: PaymentPayload,
  required: PaymentRequirements,
  asset: X402Asset,
  nowSeconds: number,
): string | null {
  if (payment.x402Version !== X402_VERSION) return 'invalid_x402_version'
  const accepted = payment.accepted
  if (!accepted || accepted.scheme !== 'exact') return 'unsupported_scheme'
  if (accepted.network !== required.network) return 'invalid_network'
  if (!sameAddress(accepted.asset, required.asset) || !sameAddress(accepted.payTo, required.payTo)) {
    return 'invalid_payment_requirements'
  }
  const authorization = payment.payload?.authorization
  const signature = payment.payload?.signature
  if (!authorization || typeof signature !== 'string') return 'invalid_payload'
  if (!sameAddress(authorization.to, required.payTo)) return 'invalid_exact_evm_payload_recipient_mismatch'
  if (authorization.value !== required.amount) return 'invalid_exact_evm_payload_authorization_value_mismatch'
  if (Number(authorization.validAfter) > nowSeconds) return 'invalid_exact_evm_payload_authorization_valid_after'
  // Leave the facilitator enough time to land the transaction.
  if (Number(authorization.validBefore) < nowSeconds + 6) return 'invalid_exact_evm_payload_authorization_valid_before'
  let signer: string
  try {
    signer = verifyTypedData(
      { name: asset.name, version: asset.version, chainId: asset.chainId, verifyingContract: asset.address },
      TRANSFER_WITH_AUTHORIZATION_TYPES,
      authorization,
      signature,
    )
  } catch {
    return 'invalid_exact_evm_payload_signature'
  }
  return sameAddress(signer, authorization.from) ? null : 'invalid_exact_evm_payload_signature'
}

export interface FacilitatorOptions {
  url: string
  /** Sent as the Authorization header, e.g. `Bearer <token>`. */
  authorization?: string
  fetchImpl?: typeof fetch
}

/** Client for the standard facilitator `/verify` and `/settle` endpoints. */
export class X402Facilitator {
  constructor(private readonly _options: FacilitatorOptions) {}

  async verify(payment: PaymentPayload, requirements: PaymentRequirements): Promise<{ isValid: boolean; invalidReason?: string }> {
    return this._post('verify', payment, requirements) as Promise<{ isValid: boolean; invalidReason?: string }>
  }

  async settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<SettlementResponse> {
    return this._post('settle', payment, requirements) as Promise<SettlementResponse>
  }

  private async _post(path: 'verify' | 'settle', payment: PaymentPayload, requirements: PaymentRequirements): Promise<unknown> {
    const fetchImpl = this._options.fetchImpl ?? fetch
    const response = await fetchImpl(`${this._options.url.replace(/\/+$/, '')}/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this._options.authorization ? { authorization: this._options.authorization } : {}),
      },
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: requirements }),
      signal: AbortSignal.timeout(path === 'settle' ? 90_000 : 15_000),
    })
    const body = await response.json().catch(() => null)
    if (!body || typeof body !== 'object') throw new Error(`Facilitator /${path} answered ${response.status} without a JSON body`)
    return body
  }
}
