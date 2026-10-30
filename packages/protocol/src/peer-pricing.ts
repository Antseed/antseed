import type { ServiceUnitBillingModelsV1 } from './billing.js';
import type { ServiceCapabilities, ServiceHealth, TokenPricingUsdPerMillion } from './peer-metadata.js';
import type { ServiceApiProtocol } from './service-api.js';

export interface ProviderPricingMatrixEntry {
  defaults: TokenPricingUsdPerMillion;
  services?: Record<string, TokenPricingUsdPerMillion>;
}

export interface ProviderServiceCategoryMatrixEntry {
  services: Record<string, string[]>;
}

export interface ProviderServiceApiProtocolMatrixEntry {
  services: Record<string, ServiceApiProtocol[]>;
}

export interface ProviderServiceUnitBillingModelMatrixEntry {
  services: ServiceUnitBillingModelsV1;
}

export interface ProviderServiceCapabilityMatrixEntry {
  services: Record<string, ServiceCapabilities>;
}

export interface ProviderServiceHealthMatrixEntry {
  services: Record<string, ServiceHealth>;
  /** Per service, API protocols only failing upstreams serve, while another route of the service works. */
  failingProtocols?: Record<string, ServiceApiProtocol[]>;
}
