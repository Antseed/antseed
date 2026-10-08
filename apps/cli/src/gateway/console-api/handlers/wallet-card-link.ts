/**
 * Signed Antseed Pay funding links for a workspace wallet. The link itself
 * is built by `@antseed/payments/card-link`, the same code the desktop uses
 * (`payments:open-card-provider`), so both produce the same bytes; this
 * module adds the gateway's amount bounds and pay-page URL setting.
 */
import { ANTSEED_PAY_INTEGRATIONS, antseedPayMessage, buildAntseedPayLink, DEFAULT_ANTSEED_PAY_URL, type AntseedPayIntegration } from '@antseed/payments/card-link'

export type CardProvider = AntseedPayIntegration

export const CARD_PROVIDERS: readonly CardProvider[] = ANTSEED_PAY_INTEGRATIONS
export { DEFAULT_ANTSEED_PAY_URL }
/** Deposits take at least 1 USDC on a first deposit; the upper bound only catches typos. */
const CARD_MIN_USD = 1
const CARD_MAX_USD = 10_000

export function antseedPayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env['ANTSEED_PAY_URL']?.trim() || DEFAULT_ANTSEED_PAY_URL
}

/**
 * The amount as the desktop writes it, `String(Number(input))` ("10.50" →
 * "10.5"); throws a user-facing message when it is out of bounds.
 */
export function cardAmountString(input: unknown): string {
  let amount = Number.NaN
  if (typeof input === 'number') amount = input
  else if (typeof input === 'string' && input.trim() !== '') amount = Number(input)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amountUsd must be a positive number.')
  if (amount < CARD_MIN_USD) throw new Error(`The minimum card deposit is $${CARD_MIN_USD}.`)
  if (amount > CARD_MAX_USD) throw new Error(`The maximum card deposit is $${CARD_MAX_USD}.`)
  return String(amount)
}

/** The signed message (the pay page's wire format). */
export const cardLinkMessage = antseedPayMessage

export async function buildCardLink(input: {
  baseUrl: string
  wallet: { address: string; signMessage(message: string): Promise<string> }
  amountUsd: unknown
  provider: CardProvider
}): Promise<string> {
  const amount = cardAmountString(input.amountUsd)
  return buildAntseedPayLink({ baseUrl: input.baseUrl, wallet: input.wallet, amount, integration: input.provider })
}
