import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AntseedProviderPlugin, Provider } from '@antseed/node';
import {
  buildServiceApiProtocols,
  parseNonNegativeNumber as parseSharedNonNegativeNumber,
  parseServiceCapabilitiesJson,
  parseServicePricingJson,
} from '@antseed/provider-core';
import { WorkerLedger } from './ledger.js';
import { NanoMdmAttestor } from './mdm.js';

/** The ledger's default file in the data dir, and the file naming it when COLONY_POOL_LEDGER_PATH moves it. */
const LEDGER_FILE = 'colony-pool.db';
const LEDGER_POINTER_FILE = 'colony-pool.ledger-path';
import { ColonyPool } from './pool.js';
import { ColonyPoolProvider } from './provider.js';
import { parseWorkerPriority } from './ranking.js';

export { WorkerLedger } from './ledger.js';
export { ColonyPool, NoWorkerAvailableError, WorkerUnavailableError, type ColonyPoolOptions, type WorkerSummary } from './pool.js';
export { ColonyPoolProvider } from './provider.js';
export * from './protocol.js';
export { NanoMdmAttestor, parsePlist, deviceInformationCommand, type DeviceAttestor, type NanoMdmAttestorOptions } from './mdm.js';

/** provider-core's parser, with an empty setting meaning the default. */
function parseNonNegativeNumber(raw: string | undefined, key: string, fallback: number): number {
  return parseSharedNonNegativeNumber(raw === '' ? undefined : raw, key, fallback);
}

function parseList(raw: string | undefined): string[] {
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

const plugin: AntseedProviderPlugin = {
  name: 'colony-pool',
  displayName: 'Colony Pool',
  version: '0.1.0',
  type: 'provider',
  description: 'Serve buyers from a pool of worker machines (e.g. Macs running local models) that connect to this seller',
  configSchema: [
    { key: 'COLONY_POOL_PORT', label: 'Worker Port', type: 'number', required: false, default: 8790, description: 'Port workers connect to (WebSocket)' },
    { key: 'COLONY_POOL_HOST', label: 'Worker Bind Host', type: 'string', required: false, default: '0.0.0.0', description: 'Interface the worker server binds to' },
    { key: 'COLONY_POOL_SELLER_ADDRESS', label: 'Seller Address', type: 'string', required: true, description: 'Address buyers pay: the AntseedColonyPool contract (or this seller\'s own address). Workers certify their encryption keys for it.' },
    { key: 'COLONY_POOL_ID', label: 'Pool ID', type: 'string', required: false, description: 'Name workers sign into their join message (defaults to "antseed-pool")' },
    { key: 'COLONY_POOL_TLS_CERT', label: 'TLS Certificate', type: 'string', required: false, description: 'Path to a PEM certificate; serve wss:// directly instead of behind a TLS proxy' },
    { key: 'COLONY_POOL_TLS_KEY', label: 'TLS Key', type: 'string', required: false, description: 'Path to the PEM private key for COLONY_POOL_TLS_CERT' },
    { key: 'COLONY_POOL_WORKER_SHARE_BPS', label: 'Worker Share', type: 'number', required: false, default: 9000, description: 'Share of each paid request credited to the worker, in basis points (9000 = 90%)' },
    { key: 'COLONY_POOL_PROTOCOL_FEE_BPS', label: 'Protocol Fee', type: 'number', required: false, default: 200, description: 'AntseedChannels protocol fee in basis points, for the local earnings estimate workers see' },
    { key: 'COLONY_POOL_ALLOWED_WORKERS', label: 'Allowed Workers', type: 'string[]', required: false, description: 'Worker addresses allowed to join (empty = anyone)' },
    { key: 'COLONY_POOL_WORKER_PRIORITY', label: 'Worker Priority', type: 'string[]', required: false, description: 'Weights for ranking workers, as address=weight (default 1; 2 doubles its score; 0 never routes to it)' },
    { key: 'COLONY_POOL_REQUIRE_ATTESTATION', label: 'Require Attestation', type: 'boolean', required: false, default: false, description: 'Only admit workers attesting a hardened Mac: Developer ID signed app with the hardened runtime, SIP on, and a Secure Enclave key only that app can use' },
    { key: 'COLONY_POOL_ATTESTED_TEAMS', label: 'Attested Teams', type: 'string[]', required: false, description: 'Apple Developer team IDs whose signed worker apps count as hardened (empty = any team)' },
    { key: 'COLONY_POOL_MDM_URL', label: 'MDM URL', type: 'string', required: false, description: 'Your NanoMDM server, for Apple-signed attestations of enrolled Macs (optional; you run it, Macs enroll in it)' },
    { key: 'COLONY_POOL_MDM_API_KEY', label: 'MDM API Key', type: 'secret', required: false, description: 'NanoMDM API key' },
    { key: 'COLONY_POOL_MDM_WEBHOOK_PORT', label: 'MDM Webhook Port', type: 'number', required: false, default: 8791, description: 'Port NanoMDM posts command results to (nanomdm -webhook-url http://<pool>:<port>/<secret path>)' },
    { key: 'COLONY_POOL_MDM_WEBHOOK_PATH', label: 'MDM Webhook Path', type: 'secret', required: false, description: 'Secret path for that webhook URL, at least 16 random characters (required with the MDM)' },
    { key: 'COLONY_POOL_REQUIRE_DEVICE_ATTESTATION', label: 'Require Apple Attestation', type: 'boolean', required: false, default: false, description: 'Only route to Macs Apple attests through your MDM (SIP on, serial matches)' },
    { key: 'COLONY_POOL_VERIFY_ON_JOIN', label: 'Verify On Join', type: 'boolean', required: false, default: true, description: 'Send each newly offered model a short test completion before routing buyers to it' },
    { key: 'COLONY_POOL_LEDGER_PATH', label: 'Ledger Path', type: 'string', required: false, description: 'SQLite file for worker earnings (defaults to <data dir>/colony-pool.db)' },
    { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: 0, description: 'Input price in USD per 1M tokens' },
    { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: 0, description: 'Output price in USD per 1M tokens' },
    { key: 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', label: 'Cached Input Price', type: 'number', required: false, description: 'Cached input price in USD per 1M tokens (defaults to input price)' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 64, description: 'Cap on concurrent requests across all workers' },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Services', type: 'string[]', required: true, description: 'Services this pool sells; workers offering others are ignored' },
    { key: 'ANTSEED_SERVICE_PRICING_JSON', label: 'Service Pricing JSON', type: 'string', required: false, description: 'Per-service pricing JSON' },
    { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Service Capabilities JSON', type: 'string', required: false, description: 'Per-service model capability JSON' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const catalog = parseList(config['ANTSEED_ALLOWED_SERVICES']);
    if (catalog.length === 0) throw new Error('ANTSEED_ALLOWED_SERVICES must list the services this pool sells');

    const servicePricing = parseServicePricingJson(config['ANTSEED_SERVICE_PRICING_JSON']);
    const pricing: Provider['pricing'] = {
      defaults: {
        inputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_INPUT_USD_PER_MILLION'], 'ANTSEED_INPUT_USD_PER_MILLION', 0),
        outputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_OUTPUT_USD_PER_MILLION'], 'ANTSEED_OUTPUT_USD_PER_MILLION', 0),
        ...(config['ANTSEED_CACHED_INPUT_USD_PER_MILLION'] ? { cachedInputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_CACHED_INPUT_USD_PER_MILLION'], 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', 0) } : {}),
      },
      ...(servicePricing ? { services: servicePricing } : {}),
    };

    const workerShareBps = parseNonNegativeNumber(config['COLONY_POOL_WORKER_SHARE_BPS'], 'COLONY_POOL_WORKER_SHARE_BPS', 9000);
    if (!Number.isInteger(workerShareBps) || workerShareBps > 10_000) {
      throw new Error('COLONY_POOL_WORKER_SHARE_BPS must be a whole number from 0 to 10000');
    }
    const maxConcurrency = parseNonNegativeNumber(config['ANTSEED_MAX_CONCURRENCY'], 'ANTSEED_MAX_CONCURRENCY', 64);
    const port = parseNonNegativeNumber(config['COLONY_POOL_PORT'], 'COLONY_POOL_PORT', 8790);
    const certPath = config['COLONY_POOL_TLS_CERT'];
    const keyPath = config['COLONY_POOL_TLS_KEY'];
    if (Boolean(certPath) !== Boolean(keyPath)) throw new Error('Set both COLONY_POOL_TLS_CERT and COLONY_POOL_TLS_KEY, or neither');
    const allowedWorkers = parseList(config['COLONY_POOL_ALLOWED_WORKERS']).map((address) => address.toLowerCase());
    const attestedTeams = parseList(config['COLONY_POOL_ATTESTED_TEAMS']);
    const workerPriority = parseWorkerPriority(config['COLONY_POOL_WORKER_PRIORITY']);
    const mdmUrl = config['COLONY_POOL_MDM_URL'];
    const webhookPath = config['COLONY_POOL_MDM_WEBHOOK_PATH'];
    if (mdmUrl && !webhookPath) {
      throw new Error('COLONY_POOL_MDM_URL needs COLONY_POOL_MDM_WEBHOOK_PATH: at least 16 random characters (e.g. `openssl rand -hex 16`)');
    }
    const deviceAttestor = mdmUrl && webhookPath
      ? new NanoMdmAttestor({
        url: mdmUrl,
        apiKey: config['COLONY_POOL_MDM_API_KEY'] ?? '',
        webhookPort: parseNonNegativeNumber(config['COLONY_POOL_MDM_WEBHOOK_PORT'], 'COLONY_POOL_MDM_WEBHOOK_PORT', 8791),
        webhookPath,
        log: (line) => console.log(line),
      })
      : null;
    if (config['COLONY_POOL_REQUIRE_DEVICE_ATTESTATION'] === 'true' && !deviceAttestor) {
      throw new Error('COLONY_POOL_REQUIRE_DEVICE_ATTESTATION needs COLONY_POOL_MDM_URL');
    }
    const dataDir = config['ANTSEED_DATA_DIR'] ?? '.';
    const seller = config['COLONY_POOL_SELLER_ADDRESS'];
    if (!seller || !/^0x[0-9a-fA-F]{40}$/.test(seller)) {
      throw new Error('COLONY_POOL_SELLER_ADDRESS must be the address buyers pay (the AntseedColonyPool contract)');
    }

    const ledgerPath = resolve(config['COLONY_POOL_LEDGER_PATH'] || join(dataDir, LEDGER_FILE));
    const ledger = new WorkerLedger(ledgerPath);
    // The seller dashboard finds a moved ledger through this pointer (apps/cli seller-monitor).
    const pointer = join(dataDir, LEDGER_POINTER_FILE);
    if (ledgerPath === resolve(join(dataDir, LEDGER_FILE))) rmSync(pointer, { force: true });
    else writeFileSync(pointer, `${ledgerPath}\n`);
    const pool = new ColonyPool({
      poolId: config['COLONY_POOL_ID'] || 'antseed-pool',
      seller: seller.toLowerCase(),
      catalog,
      workerShareBps,
      ledger,
      port,
      ...(config['COLONY_POOL_HOST'] ? { host: config['COLONY_POOL_HOST'] } : {}),
      ...(certPath && keyPath ? { tls: { cert: readFileSync(certPath, 'utf-8'), key: readFileSync(keyPath, 'utf-8') } } : {}),
      ...(allowedWorkers.length > 0 ? { allowedWorkers: new Set(allowedWorkers) } : {}),
      ...(workerPriority.size > 0 ? { workerPriority } : {}),
      verifyOnJoin: config['COLONY_POOL_VERIFY_ON_JOIN'] !== 'false',
      requireAttestation: config['COLONY_POOL_REQUIRE_ATTESTATION'] === 'true',
      ...(attestedTeams.length > 0 ? { attestedTeams: new Set(attestedTeams) } : {}),
      ...(deviceAttestor ? { deviceAttestor, requireDeviceAttestation: config['COLONY_POOL_REQUIRE_DEVICE_ATTESTATION'] === 'true' } : {}),
      log: (line) => console.log(line),
    });

    const serviceApiProtocols = buildServiceApiProtocols(catalog, 'openai-chat-completions') ?? {};
    const serviceCapabilities = parseServiceCapabilitiesJson(config['ANTSEED_SERVICE_CAPABILITIES_JSON']);
    const provider = new ColonyPoolProvider({
      pool,
      ledger,
      pricing,
      workerShareBps,
      protocolFeeBps: parseNonNegativeNumber(config['COLONY_POOL_PROTOCOL_FEE_BPS'], 'COLONY_POOL_PROTOCOL_FEE_BPS', 200),
      maxConcurrency,
      serviceApiProtocols,
      ...(serviceCapabilities ? { serviceCapabilities } : {}),
    });
    return Object.assign(provider, {
      async init(): Promise<void> {
        await deviceAttestor?.start();
        const boundPort = await pool.start();
        console.log(`[colony-pool] accepting workers on port ${boundPort}`);
      },
    });
  },
};

export default plugin;
