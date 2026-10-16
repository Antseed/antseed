export type RoutingServiceTarget = { peerId: string; provider: string; serviceId: string };

/**
 * Settings sent to a routing service with each ranking, in that router's own protocol terms
 * (for `irp-suggest`: `{ cost_quality_tradeoff?: 0-10 }`). The buyer keeps them opaque; the
 * router's protocol adapter validates them before a ranking is bought.
 */
export type RouterOptions = Record<string, string | number | boolean>;

const MAX_ROUTER_OPTIONS = 32;

/** A plain object of at most 32 string, finite number or boolean values with short keys. */
export function isRouterOptions(value: unknown): value is RouterOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_ROUTER_OPTIONS && entries.every(([key, option]) => key.length > 0 && key.length <= 64
    && ((typeof option === 'string' && option.length <= 256) || (typeof option === 'number' && Number.isFinite(option)) || typeof option === 'boolean'));
}

/** Choose an explicit model or a service that recommends models, independently of billing. */
export type RoutingSelection =
  | { kind: 'model'; model: string | null }
  | {
    kind: 'router';
    service?: RoutingServiceTarget;
    /** Router settings in the router's protocol terms; the router's defaults apply when unset. */
    options?: RouterOptions;
    allowedModels?: Array<{ provider: string; serviceId: string }>;
  };

export function isRoutingSelection(value: unknown): value is RoutingSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  if (selection.kind === 'model') {
    return Object.keys(selection).every(key => key === 'kind' || key === 'model')
      && (selection.model === null || (typeof selection.model === 'string' && selection.model.trim().length > 0));
  }
  if (selection.kind !== 'router' || Object.keys(selection).some(key => !['kind', 'service', 'options', 'allowedModels'].includes(key))) return false;
  if (selection.allowedModels !== undefined && (!Array.isArray(selection.allowedModels) || selection.allowedModels.length > 512
    || selection.allowedModels.some(model => !model || typeof model !== 'object' || Array.isArray(model)
      || Object.keys(model).some(key => !['provider', 'serviceId'].includes(key))
      || typeof model.provider !== 'string' || !model.provider.trim() || model.provider.length > 128
      || typeof model.serviceId !== 'string' || !model.serviceId.trim() || model.serviceId.length > 256))) return false;
  if (selection.options !== undefined && !isRouterOptions(selection.options)) return false;
  if (selection.service === undefined) return true;
  if (!selection.service || typeof selection.service !== 'object' || Array.isArray(selection.service)) return false;
  const service = selection.service as Record<string, unknown>;
  return Object.keys(service).every(key => ['peerId', 'provider', 'serviceId'].includes(key))
    && typeof service.peerId === 'string' && /^[0-9a-f]{40}$/.test(service.peerId)
    && typeof service.provider === 'string' && service.provider.trim().length > 0
    && typeof service.serviceId === 'string' && service.serviceId.trim().length > 0;
}
