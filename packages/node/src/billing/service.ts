import type { Provider } from '../interfaces/seller-provider.js';
import { resolveCompletedRequestBilling, type ServiceBillingOffer } from '@antseed/protocol/service-billing';
import { isCompletedRequestBillingModel } from '@antseed/protocol/billing';

export function completedRequestOffer(provider: Provider, service: string): ServiceBillingOffer | undefined {
  const billingModels = provider.serviceUnitBillingModels?.[service];
  if (!Object.values(billingModels ?? {}).some(isCompletedRequestBillingModel)) return undefined;
  const billing = resolveCompletedRequestBilling(billingModels);
  if (provider.serviceApiProtocols?.[service]?.some(protocol => !billingModels?.[protocol])) {
    throw new Error('Completed-request services require the same unit price across their API protocols');
  }
  return { provider: provider.name, service, ...billing };
}

export function isLegacyInferenceService(provider: Provider, service: string): boolean {
  return !provider.serviceApiProtocols?.[service]?.includes('model-routing') && !completedRequestOffer(provider, service);
}
