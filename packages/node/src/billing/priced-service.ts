import type { Provider } from '../interfaces/seller-provider.js';
import { isFreeUnitBillingModel } from './unit.js';

/**
 * Whether a provider charges for `serviceId`: a positive input, output or
 * cached-input token rate (the service's own rates, else the provider
 * defaults), or any unit billing model that isn't free.
 */
export function isPricedProviderService(
  provider: Pick<Provider, 'pricing' | 'serviceUnitBillingModels'>,
  serviceId: string,
): boolean {
  const pricing = provider.pricing.services?.[serviceId] ?? provider.pricing.defaults;
  const tokenPriced = pricing.inputUsdPerMillion > 0 || pricing.outputUsdPerMillion > 0 || (pricing.cachedInputUsdPerMillion ?? 0) > 0;
  if (tokenPriced) return true;
  return Object.values(provider.serviceUnitBillingModels?.[serviceId] ?? {})
    .some((model) => model !== undefined && !isFreeUnitBillingModel(model));
}
