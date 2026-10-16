import type { RouterOptions, RoutingSelection, RoutingServiceTarget } from '@antseed/node';
import { preferredModelDisplayName } from '@antseed/node/model-identity';

export type { RouterOptions, RoutingServiceTarget } from '@antseed/node';

type RouterSelection = Extract<RoutingSelection, { kind: 'router' }>;
export type RouterAllowedModel = NonNullable<RouterSelection['allowedModels']>[number];
export type DesktopRouterSelection = Omit<RouterSelection, 'kind' | 'service'> & {
  service: RoutingServiceTarget;
};
export type DesktopRoutingSelection =
  | Extract<RoutingSelection, { kind: 'model' }>
  | ({ kind: 'router' } & DesktopRouterSelection);
/**
 * One setting a router accepts with each ranking, as `GET /_antseed/routing-services` describes it
 * for the router's protocol (for `irp-suggest`: `cost_quality_tradeoff`, an integer 0-10).
 */
export type RouterOptionSpec = {
  key: string;
  label: string;
  description?: string;
} & (
  | { type: 'integer' | 'number'; minimum?: number; maximum?: number; default?: number }
  | { type: 'boolean'; default?: boolean }
  | { type: 'string'; values?: readonly string[]; default?: string }
);
export type RoutingServiceEntry = RoutingServiceTarget & {
  /** Routing protocol the router speaks, e.g. `irp-suggest`. */
  protocol?: string;
  /** Settings the router's protocol accepts; the desktop renders a control for each. */
  options?: RouterOptionSpec[];
  label: string;
  priceMicroUsdc: string;
  catalog?: { models: RouterAllowedModel[] };
  catalogError?: string;
};

/** Router settings: at most 32 short keys with string, finite number or boolean values (as the buyer accepts). */
export function isRouterOptions(value: unknown): value is RouterOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 32 && entries.every(([key, option]) => key.length > 0 && key.length <= 64
    && ((typeof option === 'string' && option.length <= 256) || (typeof option === 'number' && Number.isFinite(option)) || typeof option === 'boolean'));
}

export function isDesktopRouterSelection(value: unknown): value is DesktopRouterSelection {
  if (!value || typeof value !== 'object') return false;
  const router = value as Partial<DesktopRouterSelection>;
  return !!router.service && /^[0-9a-f]{40}$/.test(router.service.peerId)
    && typeof router.service.provider === 'string' && router.service.provider.trim().length > 0
    && typeof router.service.serviceId === 'string' && router.service.serviceId.trim().length > 0
    && Object.keys(router).every(key => ['service', 'options', 'allowedModels'].includes(key))
    && (router.options === undefined || isRouterOptions(router.options))
    && (router.allowedModels === undefined || (Array.isArray(router.allowedModels) && router.allowedModels.length <= 512
      && router.allowedModels.every(model => !!model && typeof model === 'object' && !Array.isArray(model)
        && Object.keys(model).every(key => key === 'provider' || key === 'serviceId')
        && typeof model.provider === 'string' && model.provider.trim().length > 0 && model.provider.length <= 128
        && typeof model.serviceId === 'string' && model.serviceId.trim().length > 0 && model.serviceId.length <= 256)));
}

export function routingServiceKey(service: RoutingServiceTarget): string {
  return `${service.peerId}:${service.provider}:${service.serviceId}`;
}

/** Router name from the routing provider, e.g. "Default Router" for `default-router`. */
export function routerDisplayName(service: Pick<RoutingServiceEntry, 'provider'>): string {
  return preferredModelDisplayName(service.provider);
}

/** Seller offering the router: its display name, or a short peer id when it advertises none. */
export function routerSellerName(service: Pick<RoutingServiceEntry, 'peerId' | 'provider' | 'label'>): string {
  const name = service.label.trim();
  return name && name !== service.provider ? name : `${service.peerId.slice(0, 8)}...${service.peerId.slice(-4)}`;
}

/** Picker label for an active router: its router name, or a generic label while it is undiscovered. */
export function routerAutoModelLabel(router: DesktopRouterSelection | undefined, services: readonly RoutingServiceEntry[]): string {
  const key = router ? routingServiceKey(router.service) : null;
  const service = key ? services.find(entry => routingServiceKey(entry) === key) : undefined;
  return `${service ? routerDisplayName(service) : 'Router'} · Auto model`;
}

export function normalizeRouterAllowedModels(allowedModels: RouterAllowedModel[] | undefined, availableModels?: RouterAllowedModel[]): RouterAllowedModel[] | undefined {
  if (!allowedModels?.length || allowedModels.length > 512) return undefined;
  if (!availableModels) return allowedModels;
  const valid = allowedModels.filter(model => availableModels.some(available => available.provider === model.provider && available.serviceId === model.serviceId));
  return valid.length === allowedModels.length ? allowedModels : valid.length ? valid : undefined;
}

export function createDesktopRouterSelection(service: RoutingServiceTarget, options?: RouterOptions, allowedModels?: RouterAllowedModel[]): DesktopRouterSelection {
  allowedModels = normalizeRouterAllowedModels(allowedModels);
  return { service: { peerId: service.peerId, provider: service.provider, serviceId: service.serviceId },
    ...(options === undefined || Object.keys(options).length === 0 ? {} : { options: { ...options } }),
    ...(allowedModels === undefined ? {} : { allowedModels: allowedModels.map(({ provider, serviceId }) => ({ provider, serviceId })) }) };
}
