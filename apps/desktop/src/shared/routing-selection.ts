import type { RoutingSelection, RoutingServiceTarget } from '@antseed/node';

export type { RoutingServiceTarget } from '@antseed/node';

type RouterSelection = Extract<RoutingSelection, { kind: 'router' }>;
export type RouterAllowedModel = NonNullable<RouterSelection['allowedModels']>[number];
export type DesktopRouterSelection = Omit<RouterSelection, 'kind' | 'service'> & {
  service: RoutingServiceTarget;
};
export type DesktopRoutingSelection =
  | Extract<RoutingSelection, { kind: 'model' }>
  | ({ kind: 'router' } & DesktopRouterSelection);
export type RoutingServiceEntry = RoutingServiceTarget & {
  label: string;
  priceMicroUsdc: string;
  catalog?: { models: RouterAllowedModel[] };
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

/** Picker label for an active router: its discovered name, or a generic label while it is undiscovered. */
export function routerAutoModelLabel(router: DesktopRouterSelection | undefined, services: readonly RoutingServiceEntry[]): string {
  const key = router ? routingServiceKey(router.service) : null;
  const label = key ? services.find(service => routingServiceKey(service) === key)?.label.trim() : undefined;
  return `${label || 'Router'} · Auto model`;
}

export function normalizeRouterAllowedModels(allowedModels: RouterAllowedModel[] | undefined, availableModels?: RouterAllowedModel[]): RouterAllowedModel[] | undefined {
  if (!allowedModels?.length || allowedModels.length > 512) return undefined;
  if (!availableModels) return allowedModels;
  const valid = allowedModels.filter(model => availableModels.some(available => available.provider === model.provider && available.serviceId === model.serviceId));
  return valid.length === allowedModels.length ? allowedModels : valid.length ? valid : undefined;
}

export function createDesktopRouterSelection(service: RoutingServiceTarget, costQualityTradeoff?: number, allowedModels?: RouterAllowedModel[]): DesktopRouterSelection {
  allowedModels = normalizeRouterAllowedModels(allowedModels);
  return { service: { peerId: service.peerId, provider: service.provider, serviceId: service.serviceId },
    ...(costQualityTradeoff === undefined ? {} : { costQualityTradeoff }),
    ...(allowedModels === undefined ? {} : { allowedModels: allowedModels.map(({ provider, serviceId }) => ({ provider, serviceId })) }) };
}
