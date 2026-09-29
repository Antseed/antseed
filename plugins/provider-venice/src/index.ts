import type { AntseedProviderPlugin } from '@antseed/node';
import { createNativeVideoProvider } from '@antseed/provider-core';
import { withVeniceRetrieve } from './retrieve.js';
import { withVeniceModelOptions } from './models.js';

export const VENICE_DEFAULT_BASE_URL = 'https://api.venice.ai';

const plugin: AntseedProviderPlugin = {
  name: 'venice', displayName: 'Venice', version: '0.1.0-beta.0', type: 'provider',
  description: 'Relay native Venice video requests to the Venice API',
  configSchema: [
    { key: 'VENICE_BASE_URL', label: 'Venice API URL', type: 'string', default: VENICE_DEFAULT_BASE_URL },
    { key: 'VENICE_API_KEY', label: 'Venice API Key', type: 'secret', required: true },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Services', type: 'string[]', required: true },
    { key: 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON', label: 'Unit Pricing', type: 'string', required: true },
    { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Capabilities', type: 'string' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Concurrency', type: 'number', default: 10 },
  ],
  createProvider(config) {
    const apiKey = config['VENICE_API_KEY']?.trim() ?? '';
    if (!apiKey) throw new Error('Seller API authentication is required');
    const baseUrl = config['VENICE_BASE_URL']?.trim() || VENICE_DEFAULT_BASE_URL;
    const provider = createNativeVideoProvider({
      name: 'venice',
      protocol: 'venice-video',
      relay: { baseUrl, authHeaderName: 'authorization', authHeaderValue: `Bearer ${apiKey}` },
    }, config);
    return withVeniceModelOptions(withVeniceRetrieve(provider, baseUrl, apiKey), baseUrl, apiKey);
  },
};

export default plugin;
