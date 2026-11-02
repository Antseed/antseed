/** Public gateways tried in order when no gateway is configured; evidence is hash-checked, so any gateway is safe. */
export const DEFAULT_IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs',
  'https://gateway.pinata.cloud/ipfs',
  'https://dweb.link/ipfs',
] as const

const FETCH_TIMEOUT_MS = 30_000

export interface IpfsFetchOptions {
  /** Use only this gateway instead of the default list. */
  ipfsGateway?: string
  fetchImpl?: typeof fetch
}

/** Fetches `<cid>/<path>` from the first gateway that answers, trying the next one on errors and rate limits. */
export async function fetchIpfsText(cidPath: string, options: IpfsFetchOptions = {}): Promise<string> {
  const gateways = options.ipfsGateway ? [options.ipfsGateway] : DEFAULT_IPFS_GATEWAYS
  const fetchImpl = options.fetchImpl ?? fetch
  const failures: string[] = []
  for (const gateway of gateways) {
    const url = `${gateway.replace(/\/+$/, '')}/${cidPath}`
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (response.ok) return await response.text()
      failures.push(`${url}: HTTP ${response.status}`)
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`failed to fetch ipfs://${cidPath} (${failures.join('; ')}); try another --ipfs-gateway`)
}
