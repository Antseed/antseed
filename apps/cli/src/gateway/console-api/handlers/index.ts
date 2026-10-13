import type { ConsoleRegistrar } from '../server.js'
import { registerAdminTokenRoutes } from './admin-tokens.js'
import { registerKeyRoutes } from './keys.js'
import { registerOrgRoutes } from './org.js'
import { registerPeerListRoutes } from './peer-lists.js'
import { registerPresetRoutes } from './presets.js'
import { registerRoutingRoutes } from './routing.js'
import { registerSettingsRoutes } from './settings.js'
import { registerStatusRoutes } from './status.js'
import { registerUsageRoutes } from './usage.js'
import { registerWorkspaceRoutes } from './workspaces.js'

/** Route modules owned by the gateway core; wallet and network routes are mounted separately. */
export const coreConsoleRegistrars: ConsoleRegistrar[] = [
  registerOrgRoutes,
  registerWorkspaceRoutes,
  registerKeyRoutes,
  registerAdminTokenRoutes,
  registerUsageRoutes,
  registerPeerListRoutes,
  registerPresetRoutes,
  registerRoutingRoutes,
  registerSettingsRoutes,
  registerStatusRoutes,
]
