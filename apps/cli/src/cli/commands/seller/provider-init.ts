import type { Provider } from '@antseed/node'

/** Defer only known OAuth renewal failures to model health probes. */
export async function initializeProvider(provider: Provider, healthChecksEnabled: boolean): Promise<boolean> {
  try {
    await provider.init?.()
    return true
  } catch (err) {
    // Plugins can load a different copy of provider-core, so match the error
    // code rather than the OAuthRefreshError class identity.
    const isOAuthFailure = err instanceof Error
      && 'code' in err && err.code === 'ANTSEED_OAUTH_REFRESH_FAILED'
    if (!healthChecksEnabled || !isOAuthFailure) throw err
    provider.healthCheckAvailable = false
    return false
  }
}
