import { readFileSync } from 'node:fs'
import type { SystemProxyConfigPatch, SystemProxyForwardRule, SystemProxyProfile, SystemProxyProfileMetadata, SystemProxySource } from './types.js'

const PROFILES_JSON_ENV = 'ANTSEED_SYSTEM_PROXY_PROFILES_JSON'
const PROFILES_FILE_ENV = 'ANTSEED_SYSTEM_PROXY_PROFILES_FILE'
const APP_ACTIONS = new Set<NonNullable<SystemProxyProfileMetadata['appAction']>>([
  'none',
  'open-url',
  'open-tool',
  'restart-app',
])

export function loadSystemProxyProfiles(env: NodeJS.ProcessEnv = process.env): readonly SystemProxyProfile[] {
  const raw = env[PROFILES_JSON_ENV]?.trim()
    || (env[PROFILES_FILE_ENV]?.trim()
      ? readFileSync(env[PROFILES_FILE_ENV]!.trim(), 'utf8')
      : '')
  if (!raw) return []

  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error(`${PROFILES_JSON_ENV} / ${PROFILES_FILE_ENV} must define a JSON array of profiles`)
  }
  return parsed.map((profile, index) => normalizeProfile(profile, index))
}

export const CONFIGURED_PROFILES: readonly SystemProxyProfile[] = loadSystemProxyProfiles()

function normalizeProfile(value: unknown, index: number): SystemProxyProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`System Proxy profile at index ${index} must be an object`)
  }
  const raw = value as Record<string, unknown>
  const name = requiredString(raw, 'name', index)
  const displayName = optionalString(raw, 'displayName') ?? `Tool ${index + 1}`
  const kind = raw['kind'] === 'config-patch' ? 'config-patch' : 'proxy'
  const domains = stringArray(raw['domains'])
  const pathPrefixes = stringArray(raw['pathPrefixes'])
  const forward = normalizeForward(raw['forward'], name)
  const configPatch = normalizeConfigPatch(raw['configPatch'], name)
  const metadata = normalizeMetadata(raw['metadata'], name)

  return {
    name,
    displayName,
    kind,
    domains,
    pathPrefixes,
    ...(forward ? { forward } : {}),
    ...(configPatch ? { configPatch } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

function normalizeForward(value: unknown, profileName: string): SystemProxyForwardRule | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`forward for ${profileName} must be an object`)
  }
  const raw = value as Record<string, unknown>
  const source = optionalString(raw, 'source') ?? profileName
  return {
    source,
    ...(optionalString(raw, 'targetPath') ? { targetPath: optionalString(raw, 'targetPath') } : {}),
    ...(raw['headers'] === 'browser-sse' || raw['headers'] === 'preserve' ? { headers: raw['headers'] } : {}),
    ...(Array.isArray(raw['stripHeaders']) ? { stripHeaders: stringArray(raw['stripHeaders']) } : {}),
    ...(raw['request'] && typeof raw['request'] === 'object' && !Array.isArray(raw['request']) ? { request: raw['request'] as SystemProxyForwardRule['request'] } : {}),
    ...(raw['response'] && typeof raw['response'] === 'object' && !Array.isArray(raw['response']) ? { response: raw['response'] as SystemProxyForwardRule['response'] } : {}),
    ...(raw['cors'] && typeof raw['cors'] === 'object' && !Array.isArray(raw['cors']) ? { cors: raw['cors'] as SystemProxyForwardRule['cors'] } : {}),
  }
}

function normalizeConfigPatch(value: unknown, profileName: string): SystemProxyConfigPatch | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`configPatch for ${profileName} must be an object`)
  }
  const raw = value as Record<string, unknown>
  const providerKey = optionalString(raw, 'providerKey')
  return {
    ...raw,
    configPath: requiredString(raw, 'configPath', profileName),
    // The desktop applies patches; the CLI passes the payload through. Not
    // every format carries a provider entry (claude-desktop does not).
    ...(providerKey ? { providerKey } : {}),
  }
}

function normalizeMetadata(value: unknown, profileName: string): SystemProxyProfileMetadata | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`metadata for ${profileName} must be an object`)
  }
  const raw = value as Record<string, unknown>
  const icon = optionalString(raw, 'icon')
  const displayLabel = optionalString(raw, 'displayLabel')
  const methodLabel = optionalString(raw, 'methodLabel')
  const appActionValue = raw['appAction']
  const appAction = isAppAction(appActionValue) ? appActionValue : undefined
  const openUrl = optionalString(raw, 'openUrl')
  const toolName = optionalString(raw, 'toolName')
  const restartAppName = optionalString(raw, 'restartAppName')
  const metadata: SystemProxyProfileMetadata = {
    ...(icon ? { icon } : {}),
    ...(displayLabel ? { displayLabel } : {}),
    ...(methodLabel ? { methodLabel } : {}),
    ...(appAction ? { appAction } : {}),
    ...(openUrl ? { openUrl } : {}),
    ...(toolName ? { toolName } : {}),
    ...(restartAppName ? { restartAppName } : {}),
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined
}

function isAppAction(value: unknown): value is NonNullable<SystemProxyProfileMetadata['appAction']> {
  return typeof value === 'string' && APP_ACTIONS.has(value as NonNullable<SystemProxyProfileMetadata['appAction']>)
}

function requiredString(raw: Record<string, unknown>, key: string, context: string | number): string {
  const value = raw[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`System Proxy profile ${context} requires a non-empty ${key}`)
  }
  return value.trim()
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export function findProfile(name: string): SystemProxyProfile | undefined {
  return CONFIGURED_PROFILES.find((p) => p.name === name)
}

export function isConfigPatchProfile(name: string): boolean {
  return findProfile(name)?.kind === 'config-patch'
}

export function partitionProfiles(profileNames: string[]): { proxy: string[]; configPatch: string[] } {
  const proxy: string[] = []
  const configPatch: string[] = []
  for (const name of profileNames) {
    if (isConfigPatchProfile(name)) configPatch.push(name)
    else proxy.push(name)
  }
  return { proxy, configPatch }
}

export function resolveProxiedDomains(profileNames: string[]): Set<string> {
  const domains = new Set<string>()
  for (const name of profileNames) {
    const profile = findProfile(name)
    if (!profile || profile.kind === 'config-patch') continue
    for (const domain of profile.domains) {
      domains.add(domain)
    }
  }
  return domains
}

export function resolveProxiedPathPrefixes(profileNames: string[]): Map<string, Set<string>> {
  const prefixesByDomain = new Map<string, Set<string>>()
  for (const name of profileNames) {
    const profile = findProfile(name)
    if (!profile || profile.kind === 'config-patch') continue
    for (const domain of profile.domains) {
      const prefixes = prefixesByDomain.get(domain) ?? new Set<string>()
      for (const prefix of profile.pathPrefixes) {
        prefixes.add(prefix)
      }
      prefixesByDomain.set(domain, prefixes)
    }
  }
  return prefixesByDomain
}

export function resolveSystemProxySources(profileNames: string[]): Map<string, Map<string, SystemProxySource>> {
  const sourcesByDomain = new Map<string, Map<string, SystemProxySource>>()
  for (const name of profileNames) {
    const profile = findProfile(name)
    if (!profile || profile.kind === 'config-patch') continue
    const source = profile.forward?.source ?? profile.name
    for (const domain of profile.domains) {
      const sources = sourcesByDomain.get(domain) ?? new Map<string, SystemProxySource>()
      for (const prefix of profile.pathPrefixes) {
        sources.set(prefix, source)
      }
      sourcesByDomain.set(domain, sources)
    }
  }
  return sourcesByDomain
}

export function resolveSystemProxyForwardRules(profileNames: string[]): Map<string, SystemProxyForwardRule> {
  const rulesByDomain = new Map<string, SystemProxyForwardRule>()
  for (const name of profileNames) {
    const profile = findProfile(name)
    if (!profile?.forward || profile.kind === 'config-patch') continue
    for (const domain of profile.domains) {
      rulesByDomain.set(domain, profile.forward)
    }
  }
  return rulesByDomain
}
