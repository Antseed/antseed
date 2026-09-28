import type { RoutingCatalogV1, RoutingPreferenceSchema, RoutingPreferences } from '@antseed/node';

export type RouterPreferences = RoutingPreferences;
export type RoutingServiceTarget = { peerId: string; provider: string; serviceId: string };
export type RouterAllowedModel = { provider: string; serviceId: string };
export type DesktopRouterSelection = {
  service: RoutingServiceTarget;
  preferences: RouterPreferences;
  allowedModels?: RouterAllowedModel[];
};
export type DesktopRoutingSelection =
  | { kind: 'model'; model: string | null }
  | ({ kind: 'router' } & DesktopRouterSelection);
export type RoutingServiceEntry = RoutingServiceTarget & {
  label: string;
  sellerName?: string;
  priceMicroUsdc: string;
  catalog?: RoutingCatalogV1;
  catalogExpiresAt?: number;
  catalogError?: string;
};

export function isDesktopRouterSelection(value: unknown): value is DesktopRouterSelection {
  if (!value || typeof value !== 'object') return false;
  const router = value as Partial<DesktopRouterSelection>;
  return !!router.service && /^[0-9a-f]{40}$/.test(router.service.peerId)
    && typeof router.service.provider === 'string' && router.service.provider.trim().length > 0
    && typeof router.service.serviceId === 'string' && router.service.serviceId.trim().length > 0
    && !!router.preferences && typeof router.preferences === 'object' && !Array.isArray(router.preferences)
    && Object.entries(router.preferences).every(([key, choice]) => !['__proto__', 'constructor', 'prototype'].includes(key) && typeof choice === 'string')
    && new TextEncoder().encode(JSON.stringify(router.preferences)).length <= 16 * 1024
    && (router.allowedModels === undefined || (Array.isArray(router.allowedModels) && router.allowedModels.length <= 512
      && router.allowedModels.every(model => !!model && typeof model === 'object' && !Array.isArray(model)
        && Object.keys(model).every(key => key === 'provider' || key === 'serviceId')
        && typeof model.provider === 'string' && model.provider.trim().length > 0 && model.provider.length <= 128
        && typeof model.serviceId === 'string' && model.serviceId.trim().length > 0 && model.serviceId.length <= 256)));
}

export function routingServiceKey(service: RoutingServiceTarget): string {
  return `${service.peerId}:${service.provider}:${service.serviceId}`;
}

export function routerPreferenceDefaults(schema?: RoutingPreferenceSchema): RouterPreferences {
  return Object.fromEntries(Object.entries(schema?.properties ?? {}).flatMap(([key, field]) => field.default === undefined ? [] : [[key, field.default]]));
}

export function routerPreferenceError(schema: RoutingPreferenceSchema | undefined, values: RouterPreferences): string | null {
  for (const key of Object.keys(values)) {
    if (!schema || !Object.prototype.hasOwnProperty.call(schema.properties, key)) return `Setting ${key} is no longer advertised. Remove it before saving.`;
    if (!schema.properties[key]!.enum.includes(values[key]!)) return `Choose an advertised value for ${key}.`;
  }
  for (const key of schema?.required ?? []) {
    if (values[key] === undefined && schema?.properties[key]?.default === undefined) return `Choose a value for ${key}.`;
  }
  return null;
}

export function createDesktopRouterSelection(service: RoutingServiceTarget, preferences: RouterPreferences = {}, allowedModels?: RouterAllowedModel[]): DesktopRouterSelection {
  return { service: { peerId: service.peerId, provider: service.provider, serviceId: service.serviceId }, preferences: { ...preferences },
    ...(allowedModels === undefined ? {} : { allowedModels: allowedModels.map(({ provider, serviceId }) => ({ provider, serviceId })) }) };
}
