import { RelayServer } from './server.js';
import { SellerCache, parseStaticSellers } from './seller-cache.js';

const config = {
  port: intEnv('RELAY_PORT', 8917),
  host: process.env.RELAY_HOST,
  dht: process.env.RELAY_DISABLE_DHT !== '1',
  pollIntervalMs: intEnv('RELAY_POLL_MS', 5 * 60_000),
  staticSellers: parseStaticSellers(process.env.RELAY_STATIC_SELLERS ?? ''),
  maxBridgesPerIp: intEnv('RELAY_MAX_BRIDGES_PER_IP', 16),
  maxBridgesGlobal: intEnv('RELAY_MAX_BRIDGES_GLOBAL', 1024),
  maxBridgesPerSeller: intEnv('RELAY_MAX_BRIDGES_PER_SELLER', 8),
  maxPayloadBytes: intEnv('RELAY_MAX_PAYLOAD_BYTES', 1024 * 1024),
  tcpConnectTimeoutMs: intEnv('RELAY_TCP_CONNECT_TIMEOUT_MS', 10_000),
  idleTimeoutMs: intEnv('RELAY_IDLE_TIMEOUT_MS', 10 * 60_000),
  readinessMaxAgeMs: intEnv('RELAY_READINESS_MAX_AGE_MS', 15 * 60_000),
  allowedOrigins: csvEnv('RELAY_ALLOWED_ORIGINS'),
  trustProxy: process.env.RELAY_TRUST_PROXY === '1',
};

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid ${name}: ${raw}`);
  return value;
}

function csvEnv(name: string): string[] {
  return (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

const cache = new SellerCache({
  dht: config.dht,
  pollIntervalMs: config.pollIntervalMs,
  staticSellers: config.staticSellers,
});
const server = new RelayServer(cache, config);

cache.start();
await server.start();
console.log(
  `[relay] listening on ${config.host ?? '0.0.0.0'}:${config.port} ` +
  `(dht=${config.dht}, static sellers=${config.staticSellers.length})`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    cache.stop();
    void server.stop().then(() => process.exit(0));
  });
}
