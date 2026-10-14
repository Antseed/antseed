import type { BuyerAddressBook } from '../services/wallet-address.js'
import type { HostFacts } from '../exposure.js'
import type { GatewayStore } from '../store.js'
import type { AuthConfig, Member } from './types.js'

/** What every console route module gets. */
export interface ConsoleDeps {
  store: GatewayStore
  dataDir: string
  configPath: string
  buyerPort: number
  controlSecret: string
  publicUrl: string | null
  version: string
  now: () => number
  log: (m: string) => void
  /**
   * The running buyer's identity → wallet address (null when unreachable),
   * the source of truth for workspace wallets. `createConsoleApi` fills it
   * from `buyerPort` when not set.
   */
  buyerAddresses?: BuyerAddressBook
  /**
   * Session revocation. `createConsoleApi` fills this from its ConsoleAuth
   * before calling the registrars, so route modules never need the auth
   * object itself.
   */
  sessions?: { revokeMemberSessions(memberId: string): void; revokeKeySessions(keyId: string): void }
  /** A member's sign-in credentials (auth owns that table); empty when not wired. */
  memberCredentials?: (memberId: string) => Member['credentials']
  /** Auth configuration for `GET /settings`; a conservative default when not wired. */
  authConfig?: () => Promise<AuthConfig> | AuthConfig
  /** Spend feed state of the running gateway, for `GET /status`. */
  spendFeedState?: () => string
  /** Whether x402 top-ups are enabled, for `GET /status`. */
  x402Enabled?: boolean
  /**
   * The gateway is published through its own Cloudflare tunnel, so a
   * `CF-Connecting-IP` header arriving over loopback was set by Cloudflare.
   */
  trustCloudflareHeaders?: boolean
  /**
   * Address the gateway listens on, for `GET /status` exposure checks. When
   * absent the saved console location is used.
   */
  listenHost?: string
  /** Host facts for exposure checks; inspected at startup when absent (tests inject them). */
  hostFacts?: HostFacts
}
