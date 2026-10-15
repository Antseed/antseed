import type { AntseedProviderPlugin, Provider } from '@antseed/node';
import { MODEL_ROUTING_PROTOCOL } from '@antseed/node';
import { DEFAULT_REFRESH_MS, DEFAULT_SCORES_URL, FreeModelRouter, type ScoreMetric } from './free-model-router.js';

export {
  FreeModelRouter,
  DEFAULT_ROUTER_ID,
  DEFAULT_ROUTER_VERSION,
  modelKeys,
  parseScores,
} from './free-model-router.js';
export type { FreeModelRouterOptions, ScoreMetric, ScoresPage } from './free-model-router.js';

const DEFAULT_SERVICE = 'default-router';

const csv = (raw: string | undefined): string[] =>
  [...new Set((raw ?? '').split(',').map(entry => entry.trim()).filter(Boolean))];

/**
 * AntSeed's default routing provider. It advertises one `model-routing` service and answers
 * the IRP endpoints itself: it lists `*` (any model the buyer sends) and ranks the buyer's free
 * candidates by live Artificial Analysis scores. Rankings are free unless the seller sets a price.
 */
const plugin: AntseedProviderPlugin = {
  name: 'default-router',
  displayName: 'Default Router',
  version: '0.1.0',
  type: 'provider',
  description: 'Default model-routing service that sends buyers to the best free model on the network',
  configSchema: [
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Routing Service', type: 'string[]', required: false, default: DEFAULT_SERVICE, description: 'Routing service id (exactly one)' },
    { key: 'DEFAULT_ROUTER_PRICE_USD', label: 'Price per Ranking', type: 'number', required: false, default: 0, description: 'USD charged per ranking; 0 makes routing free' },
    { key: 'DEFAULT_ROUTER_METRIC', label: 'Ranking Metric', type: 'string', required: false, default: 'intelligence', description: 'Artificial Analysis index to rank by: intelligence or coding' },
    { key: 'DEFAULT_ROUTER_MODELS', label: 'Preferred Models', type: 'string[]', required: false, description: 'Models to prefer, best first. They outrank every scored model.' },
    { key: 'DEFAULT_ROUTER_INCLUDE_PAID', label: 'Include Paid', type: 'boolean', required: false, default: false, description: 'Also rank paid candidates, after free ones and cheapest first' },
    { key: 'DEFAULT_ROUTER_SCORES_URL', label: 'Model Scores URL', type: 'string', required: false, default: DEFAULT_SCORES_URL, description: 'modelgrep-compatible model scores; empty ranks by buyer order only' },
    { key: 'DEFAULT_ROUTER_REFRESH_SECONDS', label: 'Refresh Interval', type: 'number', required: false, default: DEFAULT_REFRESH_MS / 1000, description: 'How often to refresh model scores' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 50, description: 'Max concurrent ranking requests' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const services = csv(config['ANTSEED_ALLOWED_SERVICES']);
    if (services.length > 1) throw new Error('default-router offers exactly one routing service');
    const service = services[0] ?? DEFAULT_SERVICE;

    const priceUsd = Number(config['DEFAULT_ROUTER_PRICE_USD'] ?? 0);
    if (!Number.isFinite(priceUsd) || priceUsd < 0) throw new Error('DEFAULT_ROUTER_PRICE_USD must be a non-negative number');
    const metric = (config['DEFAULT_ROUTER_METRIC']?.trim().toLowerCase() || 'intelligence') as ScoreMetric;
    if (metric !== 'intelligence' && metric !== 'coding') throw new Error('DEFAULT_ROUTER_METRIC must be intelligence or coding');
    const refreshSeconds = Number(config['DEFAULT_ROUTER_REFRESH_SECONDS'] ?? DEFAULT_REFRESH_MS / 1000);
    if (!Number.isFinite(refreshSeconds) || refreshSeconds <= 0) throw new Error('DEFAULT_ROUTER_REFRESH_SECONDS must be a positive number');
    const maxConcurrency = Number.parseInt(config['ANTSEED_MAX_CONCURRENCY'] ?? '50', 10);
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive integer');

    const router = new FreeModelRouter({
      metric,
      preferredModels: csv(config['DEFAULT_ROUTER_MODELS']),
      includePaid: config['DEFAULT_ROUTER_INCLUDE_PAID']?.trim().toLowerCase() === 'true',
      scoresUrl: config['DEFAULT_ROUTER_SCORES_URL']?.trim() ?? DEFAULT_SCORES_URL,
      refreshMs: refreshSeconds * 1000,
    });
    let active = 0;

    return {
      name: 'default-router',
      services: [service],
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceApiProtocols: { [service]: [MODEL_ROUTING_PROTOCOL] },
      // One completed request per well-formed ranking; a $0 price takes the free-service path on both sides.
      serviceUnitBillingModels: {
        [service]: { [MODEL_ROUTING_PROTOCOL]: { version: 1, components: [{ unit: 'completed_requests', priceUsd }] } },
      },
      maxConcurrency,
      init: () => router.init(),
      getCapacity: () => ({ current: active, max: maxConcurrency }),
      async handleRequest(request) {
        active++;
        try {
          return await router.handleRequest(request);
        } finally {
          active--;
        }
      },
    };
  },
};

export default plugin;
