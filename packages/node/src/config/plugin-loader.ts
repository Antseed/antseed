import type { Provider } from '../interfaces/seller-provider.js'
import type { Router } from '../interfaces/buyer-router.js'
import type { AntseedProviderPlugin, AntseedRouterPlugin, AntseedPlugin } from '../interfaces/plugin.js'
import { getInstances } from './plugin-config-manager.js'

export interface LoadedProvider {
  instanceId: string
  provider: Provider
  pluginName: string
}

export interface LoadedRouter {
  instanceId: string
  router: Router
  pluginName: string
}

/**
 * Load a plugin's default export from its npm package.
 */
export async function loadPluginModule(packageName: string, pluginsDir: string): Promise<AntseedPlugin> {
  const { join, resolve } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const pluginPath = join(pluginsDir, 'node_modules', packageName, 'dist', 'index.js')
  const resolved = resolve(pluginPath)

  if (!resolved.startsWith(resolve(pluginsDir))) {
    throw new Error(`Invalid plugin path: ${packageName}`)
  }

  let mod: { default?: unknown }
  try {
    mod = await import(/* @vite-ignore */ pathToFileURL(resolved).href) as { default?: unknown }
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new Error(`Plugin "${packageName}" failed to load from ${resolved}: ${cause}`)
  }

  const plugin = mod.default
  if (!plugin || typeof plugin !== 'object') {
    throw new Error(`Plugin "${packageName}" does not export a valid plugin object`)
  }

  const typed = plugin as { type?: string }
  if (typed.type !== 'provider' && typed.type !== 'router') {
    throw new Error(`Plugin "${packageName}" has invalid type: ${typed.type}`)
  }

  return plugin as AntseedPlugin
}

function instanceConfigToRecord(config: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(config)) {
    if (value !== null && value !== undefined) {
      result[key] = String(value)
    }
  }
  return result
}

/**
 * Load all enabled plugin instances from config and instantiate them.
 */
export async function loadAllPlugins(configPath: string, pluginsDir: string): Promise<{
  providers: LoadedProvider[]
  routers: LoadedRouter[]
}> {
  const instances = await getInstances(configPath)
  const providers: LoadedProvider[] = []
  const routers: LoadedRouter[] = []

  for (const instance of instances) {
    if (instance.enabled === false) continue

    const plugin = await loadPluginModule(instance.package, pluginsDir)
    const configRecord = instanceConfigToRecord(instance.config)

    if (instance.type === 'provider' && plugin.type === 'provider') {
      const providerPlugin = plugin as AntseedProviderPlugin
      const provider = await providerPlugin.createProvider(configRecord)
      providers.push({ instanceId: instance.id, provider, pluginName: plugin.name })
    } else if (instance.type === 'router' && plugin.type === 'router') {
      const routerPlugin = plugin as AntseedRouterPlugin
      const router = await routerPlugin.createRouter(configRecord)
      routers.push({ instanceId: instance.id, router, pluginName: plugin.name })
    }
  }

  return { providers, routers }
}
