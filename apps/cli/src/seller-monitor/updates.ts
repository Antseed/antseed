import { existsSync } from 'node:fs'
import { ConsoleError } from '../console-error.js'
import type { GatewayUpdate } from '../gateway/console-api/types.js'
import { createGatewayUpdates, type GatewayUpdates } from '../gateway/updates.js'

/** A seller in a container: it updates by a new image, not by anything run inside it. */
export function inContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.KUBERNETES_SERVICE_HOST) || existsSync('/.dockerenv')
}

/**
 * The gateway's update checks for the seller dashboard: the same npm check
 * every 30 minutes and the same view, but never installed from the page. The
 * root updater and the desktop app restart the gateway's services, not this
 * seller, so the dashboard says how this seller updates instead.
 */
export function sellerUpdates(inner: GatewayUpdates, container = inContainer()): GatewayUpdates {
  const view = (update: GatewayUpdate): GatewayUpdate => {
    const base = { ...update, progress: null, downloaded: null }
    if (container) {
      return { ...base, apply: 'none', command: null, note: `Runs in a container: deploy an image with @antseed/cli ${update.latest ?? 'latest'} to update this seller.` }
    }
    return { ...base, apply: update.command ? 'command' : 'none', note: `${update.note} Restart the seller after updating.` }
  }
  return {
    info: () => view(inner.info()),
    check: async () => view(await inner.check()),
    apply() {
      throw new ConsoleError(409, 'update_unsupported', 'The seller dashboard does not install updates; update where the seller runs, then restart it')
    },
    watch: () => inner.watch(),
    stop: () => inner.stop(),
  }
}

export function createSellerUpdates(options: { dataDir: string; current: string; log?: (line: string) => void }): GatewayUpdates {
  return sellerUpdates(createGatewayUpdates(options))
}
