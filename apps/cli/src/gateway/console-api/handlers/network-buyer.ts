/** The buyer-daemon client the wallet and network handlers share. */
import type { RoutingPolicy } from '../../../routing-policy/policy.js'
import { buyerFetch } from '../../buyer-control.js'
import { errorMessage } from '../../errors.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError } from '../router.js'

export interface BuyerRequestInit {
  method?: string
  body?: unknown
  policy?: RoutingPolicy
}

/** Calls a buyer `/_antseed/*` endpoint with the gateway's control secret. */
export type BuyerClient = (path: string, init?: BuyerRequestInit) => Promise<Response>

export function defaultBuyerClient(deps: Pick<ConsoleDeps, 'buyerPort' | 'controlSecret'>): BuyerClient {
  return (path, init) => buyerFetch({ buyerPort: deps.buyerPort, secret: deps.controlSecret }, path, init)
}

/**
 * Adds `identity=<name>` to a buyer path. Built here rather than through
 * `buyerFetch`'s `identity` option so paths that already carry a query
 * (`?all=1`) stay well-formed.
 */
export function withIdentity(path: string, identity: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}identity=${encodeURIComponent(identity)}`
}

/** JSON body of a buyer call; buyer failures become console errors the UI can show. */
export async function buyerJson(client: BuyerClient, path: string, init?: BuyerRequestInit): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await client(path, init)
  } catch (err) {
    throw new ConsoleError(502, 'buyer_unreachable', `The buyer is not reachable: ${errorMessage(err)}`)
  }
  const body = await response.json().catch(() => null) as unknown
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  if (response.ok && raw && raw['ok'] !== false) return raw
  const message = typeof raw?.['error'] === 'string' ? raw['error'] : `The buyer answered HTTP ${response.status}.`
  if (response.status === 503) throw new ConsoleError(503, 'buyer_unavailable', message)
  if (response.status >= 400 && response.status < 500) throw new ConsoleError(409, 'buyer_rejected', message)
  throw new ConsoleError(502, 'buyer_error', message)
}

/** Like `buyerJson`, but null when the buyer cannot answer (optional enrichment). */
export async function optionalBuyerJson(client: BuyerClient, path: string, init?: BuyerRequestInit): Promise<Record<string, unknown> | null> {
  return buyerJson(client, path, init).catch(() => null)
}
