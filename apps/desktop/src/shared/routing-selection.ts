export type RoutingServiceTarget = { peerId: string; provider: string; serviceId: string };
export type RouterAllowedModel = { provider: string; serviceId: string };
export type DesktopRouterSelection = {
  service: RoutingServiceTarget;
  costQualityTradeoff?: number;
  allowedModels?: RouterAllowedModel[];
};
export type DesktopRoutingSelection =
  | { kind: 'model'; model: string | null }
  | ({ kind: 'router' } & DesktopRouterSelection);
export type RoutingServiceEntry = RoutingServiceTarget & {
  label: string;
  sellerName?: string;
  priceMicroUsdc: string;
  catalog?: { models: RouterAllowedModel[] };
  catalogExpiresAt?: number;
  catalogError?: string;
};

export function isDesktopRouterSelection(value: unknown): value is DesktopRouterSelection {
  if (!value || typeof value !== 'object') return false;
  const router = value as Partial<DesktopRouterSelection>;
  return !!router.service && /^[0-9a-f]{40}$/.test(router.service.peerId)
    && typeof router.service.provider === 'string' && router.service.provider.trim().length > 0
    && typeof router.service.serviceId === 'string' && router.service.serviceId.trim().length > 0
    && Object.keys(router).every(key => ['service', 'costQualityTradeoff', 'allowedModels'].includes(key))
    && (router.costQualityTradeoff === undefined || (Number.isInteger(router.costQualityTradeoff)
      && router.costQualityTradeoff >= 0 && router.costQualityTradeoff <= 10))
    && (router.allowedModels === undefined || (Array.isArray(router.allowedModels) && router.allowedModels.length <= 512
      && router.allowedModels.every(model => !!model && typeof model === 'object' && !Array.isArray(model)
        && Object.keys(model).every(key => key === 'provider' || key === 'serviceId')
        && typeof model.provider === 'string' && model.provider.trim().length > 0 && model.provider.length <= 128
        && typeof model.serviceId === 'string' && model.serviceId.trim().length > 0 && model.serviceId.length <= 256)));
}

export function routingServiceKey(service: RoutingServiceTarget): string {
  return `${service.peerId}:${service.provider}:${service.serviceId}`;
}

export function createDesktopRouterSelection(service: RoutingServiceTarget, costQualityTradeoff?: number, allowedModels?: RouterAllowedModel[]): DesktopRouterSelection {
  return { service: { peerId: service.peerId, provider: service.provider, serviceId: service.serviceId },
    ...(costQualityTradeoff === undefined ? {} : { costQualityTradeoff }),
    ...(allowedModels === undefined ? {} : { allowedModels: allowedModels.map(({ provider, serviceId }) => ({ provider, serviceId })) }) };
}
