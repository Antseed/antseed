import type { AntseedProviderPlugin } from '@antseed/node';
import { createNativeVideoProvider } from '@antseed/provider-core';

export const ARK_DEFAULT_BASE_URL = 'https://ark.ap-southeast.bytepluses.com';

const plugin: AntseedProviderPlugin = {
  name: 'seedance', displayName: 'Seedance', version: '0.1.0-beta.0', type: 'provider',
  description: 'Relay native Seedance video requests to BytePlus ModelArk',
  configSchema: [
    { key: 'ARK_BASE_URL', label: 'ModelArk API URL', type: 'string', default: ARK_DEFAULT_BASE_URL },
    { key: 'ARK_API_KEY', label: 'Seller API Key', type: 'secret', required: true },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Services', type: 'string[]', required: true },
    { key: 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON', label: 'Unit Pricing', type: 'string', required: true },
    { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Capabilities', type: 'string' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Concurrency', type: 'number', default: 10 },
  ],
  createProvider(config) {
    const apiKey = config['ARK_API_KEY']?.trim() ?? '';
    if (!apiKey) throw new Error('Seller API authentication is required');
    return createNativeVideoProvider({
      name: 'seedance',
      protocol: 'seedance-video',
      relay: {
        baseUrl: config['ARK_BASE_URL']?.trim() || ARK_DEFAULT_BASE_URL,
        authHeaderName: 'authorization',
        authHeaderValue: `Bearer ${apiKey}`,
      },
    }, config);
  },
};

export default plugin;
