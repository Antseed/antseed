import type { Command } from 'commander'
import chalk from 'chalk'
import net from 'node:net'
import tls from 'node:tls'
import { toPeerId } from '@antseed/node'
import { DEFAULT_DHT_CONFIG, DHTNode, sellerTopics, topicToInfoHash } from '@antseed/node/discovery'

/**
 * A public entry point for a seller that has no reachable IP of its own, such as a TEE seller on
 * Phala Cloud, whose CVM ports are reachable only through Phala's TLS gateway and which receives
 * no UDP. It runs anywhere with a public IP and:
 *   - accepts buyers' TCP connections and carries each one, wrapped in TLS, to the seller's
 *     gateway address, where the gateway unwraps it into the seller's signaling port;
 *   - announces the seller on the DHT at its own address, so buyers find the seller here.
 * It is not trusted: buyers fetch the seller's signed metadata and run their encrypted session
 * (bound by the seller's TEE attestation) end to end through it, so it only sees ciphertext.
 * The seller sets `seller.publicAddress` to this forwarder's address.
 */

export interface TlsTarget {
  host: string
  port: number
}

export function parseTlsTarget(value: string): TlsTarget {
  const match = /^([a-zA-Z0-9.-]+)(?::(\d{1,5}))?$/.exec(value.trim())
  const port = match?.[2] ? Number(match[2]) : 443
  if (!match || port < 1 || port > 65535) throw new Error(`--to must be host[:port], got "${value}"`)
  return { host: match[1]!, port }
}

export interface TlsForwarderOptions {
  connect?: (target: TlsTarget) => net.Socket
  /** Buyer connections open at once; more are refused (Node's `server.maxConnections`). */
  maxConnections?: number
  /** A connection with no bytes either way for this long is closed. Buyers ping every 15 s. */
  idleTimeoutMs?: number
}

export const DEFAULT_FORWARDER_MAX_CONNECTIONS = 4096
export const DEFAULT_FORWARDER_IDLE_TIMEOUT_MS = 120_000

/** Forward every TCP connection on `listenPort` to `target` over TLS (verified against `target.host`). */
export function startTlsForwarder(listenPort: number, target: TlsTarget, {
  connect = ({ host, port }) => tls.connect({ host, port, servername: host }),
  maxConnections = DEFAULT_FORWARDER_MAX_CONNECTIONS,
  idleTimeoutMs = DEFAULT_FORWARDER_IDLE_TIMEOUT_MS,
}: TlsForwarderOptions = {}): net.Server {
  const server = net.createServer((client) => {
    const upstream = connect(target)
    const close = (): void => {
      client.destroy()
      upstream.destroy()
    }
    for (const socket of [client, upstream]) {
      socket.setKeepAlive(true, 30_000)
      // Also bounds a gateway that never answers the TLS handshake.
      socket.setTimeout(idleTimeoutMs, close)
      socket.on('error', close).on('close', close)
    }
    client.pipe(upstream).pipe(client)
  })
  server.maxConnections = maxConnections
  server.listen(listenPort)
  return server
}

export function registerSellerForwardCommand(sellerCmd: Command): void {
  sellerCmd
    .command('forward')
    .description('Give a seller without a reachable IP (e.g. a TEE seller on Phala Cloud) a public entry point')
    .requiredOption('--to <host[:port]>', "the seller's TLS gateway address, e.g. <app-id>-6882.<cluster>.phala.network")
    .requiredOption('--peer <peerId>', "the seller's peer ID (40 hex)")
    .option('--port <port>', 'TCP port buyers connect to; set seller.publicAddress to <this host>:<port>', '6882')
    .option('--dht-port <port>', 'UDP port for the DHT', '6881')
    .option('--max-connections <n>', 'buyer connections open at once', String(DEFAULT_FORWARDER_MAX_CONNECTIONS))
    .action(async (options: { to: string; peer: string; port: string; dhtPort: string; maxConnections: string }) => {
      const peerId = options.peer.trim().toLowerCase().replace(/^0x/, '')
      if (!/^[0-9a-f]{40}$/.test(peerId)) throw new Error('--peer must be a 40-hex peer ID')
      const target = parseTlsTarget(options.to)
      const port = Number(options.port)
      const dhtPort = Number(options.dhtPort)
      const maxConnections = Number(options.maxConnections)
      if (!Number.isInteger(maxConnections) || maxConnections < 1) throw new Error('--max-connections must be a positive integer')
      const server = startTlsForwarder(port, target, { maxConnections })
      const dht = new DHTNode({ ...DEFAULT_DHT_CONFIG, peerId: toPeerId(peerId), port: dhtPort })
      await dht.start()
      const announce = async (): Promise<void> => {
        const results = await Promise.allSettled(sellerTopics(peerId).map((topic) => dht.announce(topicToInfoHash(topic), port)))
        const failed = results.filter((r) => r.status === 'rejected').length
        if (failed > 0) console.error(chalk.yellow(`${failed} DHT announce(s) failed; retrying next cycle`))
      }
      await announce()
      const timer = setInterval(() => void announce(), DEFAULT_DHT_CONFIG.reannounceIntervalMs)
      console.log(`Forwarding TCP :${port} to ${target.host}:${target.port} (TLS), announcing ${peerId} on the DHT`)
      const stop = async (): Promise<void> => {
        clearInterval(timer)
        server.close()
        await dht.stop()
        process.exit(0)
      }
      process.once('SIGINT', () => void stop())
      process.once('SIGTERM', () => void stop())
    })
}
