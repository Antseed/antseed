import pkg from '../../package.json' with { type: 'json' }
import { createConsoleAuth, type ConsoleAuthService } from './auth/index.js'
import { activeMember, requestActor, requireOrgAdmin } from './console-api/access.js'
import type { ConsoleDeps } from './console-api/deps.js'
import { coreConsoleRegistrars } from './console-api/handlers/index.js'
import { registerNetworkRoutes } from './console-api/handlers/network.js'
import { registerWalletRoutes } from './console-api/handlers/wallet.js'
import { ConsoleError, respond, type ConsoleRouter } from './console-api/router.js'
import { apiKeyDto, memberDto } from './console-api/serialize.js'
import { createConsoleApi, type ConsoleRegistrar } from './console-api/server.js'
import { registerRecoveryRoutes } from './console-recovery.js'
import { removeCredential, requireMemberRecord } from './services/members.js'
import type { GatewayConsoleContext, GatewayConsoleHandle } from './runtime.js'
import type { ApiKeyRecord, MemberRecord } from './store.js'
import { CONSOLE_LOCATION_SETTING, type ConsoleLocation } from './console-location.js'

export { CONSOLE_LOCATION_SETTING, consoleBaseUrl, normalizePublicUrl, readConsoleLocation, type ConsoleLocation } from './console-location.js'

/**
 * `DELETE /members/:id/credentials/:credentialId`: org admins manage
 * anyone's sign-in methods (an owner's only another owner), and a member
 * their own. A member's last one stays, which would lock them out, unless an
 * org owner removes it from another member. Every removal is audited and
 * ends the member's other sessions (all of them when someone else removed it).
 */
function registerCredentialRoutes(auth: Pick<ConsoleAuthService, 'deleteCredential' | 'credentialsFor'>): ConsoleRegistrar {
  return (router: ConsoleRouter, deps: ConsoleDeps) => {
    router.add('DELETE', '/members/:id/credentials/:credentialId', async (request) => {
      const { principal, params } = request
      const member = requireMemberRecord(deps, params['id']!)
      const self = principal?.kind === 'member' && principal.memberId === member.id
      let callerIsOwner = false
      if (self) {
        activeMember(deps.store, principal)
      } else {
        requireOrgAdmin(principal, deps.store)
        callerIsOwner = activeMember(deps.store, principal)?.orgRole === 'owner'
        if (member.orgRole === 'owner' && !callerIsOwner) {
          throw new ConsoleError(403, 'forbidden', 'Only an owner can change an owner\'s sign-in methods')
        }
      }
      removeCredential(deps, requestActor(deps, request), auth, {
        memberId: member.id,
        credentialId: params['credentialId']!,
        // A member's last one would lock them out: only an org owner removing another member's may.
        allowLast: !self && callerIsOwner,
        selfRemoval: self,
        keepSessionId: self && principal?.kind === 'member' ? principal.sessionId : null,
      })
      return respond(204)
    })
  }
}

export interface GatewayConsoleOptions {
  dataDir: string
  configPath: string
  /** Origin the console is reached at (`--public-url`, a tunnel URL); null for localhost only. */
  publicUrl: string | null
  log: (message: string) => void
  /** Environment read for ANTSEED_OIDC_* and ANTSEED_CF_ACCESS_*; defaults to process.env. */
  env?: Record<string, string | undefined>
  /** Built console web app; defaults to the @antseed/gateway-console package's dist. */
  distDir?: string
  /** Published through the gateway's own Cloudflare tunnel; see ConsoleDeps.trustCloudflareHeaders. */
  trustCloudflareHeaders?: boolean
}

/** The `createConsole` hook `startGatewayRuntime` takes: console API, auth and web app. */
export function gatewayConsole(options: GatewayConsoleOptions): (context: GatewayConsoleContext) => GatewayConsoleHandle {
  return (context) => {
    const { store } = context
    const base: ConsoleDeps = {
      store,
      dataDir: options.dataDir,
      configPath: options.configPath,
      buyerPort: context.buyerPort,
      controlSecret: context.controlSecret,
      publicUrl: options.publicUrl,
      version: pkg.version,
      now: () => Date.now(),
      log: options.log,
      spendFeedState: context.spendFeedState,
      x402Enabled: context.x402Enabled,
      trustCloudflareHeaders: options.trustCloudflareHeaders === true,
    }
    const deps: ConsoleDeps = { ...base, ...(context.listenHost ? { listenHost: context.listenHost } : {}) }
    const auth = createConsoleAuth(base, {
      ...(options.env ? { env: options.env } : {}),
      presentMember: (member, credentials) => memberDto({ ...deps, memberCredentials: () => credentials }, member as MemberRecord),
      presentKey: (key) => apiKeyDto(store, key as ApiKeyRecord),
    })
    deps.memberCredentials = (memberId) => auth.credentialsFor(memberId)
    deps.authConfig = () => auth.authConfig()
    const api = createConsoleApi(deps, auth, [
      ...coreConsoleRegistrars,
      registerWalletRoutes,
      registerNetworkRoutes,
      registerCredentialRoutes(auth),
      registerRecoveryRoutes,
    ], options.distDir ? { distDir: options.distDir } : {})

    return {
      handle: (req, res) => api.handle(req, res),
      listening(port) {
        auth.setGatewayPort(port)
        store.setSetting(CONSOLE_LOCATION_SETTING, { publicUrl: options.publicUrl, port, host: context.listenHost ?? '127.0.0.1' } satisfies ConsoleLocation)
      },
      setupLink() {
        return auth.authConfig().setupRequired ? auth.createSetupLink() : null
      },
    }
  }
}
