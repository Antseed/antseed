import { assertRoutingPreferences, type RoutingPreferences } from '@antseed/protocol';

export type RoutingServiceTarget = { peerId: string; provider: string; serviceId: string };

/** Choose an explicit model or a service that recommends models, independently of billing. */
export type RoutingSelection =
  | { kind: 'model'; model: string | null }
  | { kind: 'router'; service?: RoutingServiceTarget; preferences?: RoutingPreferences; allowedModels?: Array<{ provider: string; serviceId: string }> };

export function isRoutingSelection(value: unknown): value is RoutingSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  if (selection.kind === 'model') {
    return Object.keys(selection).every(key => key === 'kind' || key === 'model')
      && (selection.model === null || (typeof selection.model === 'string' && selection.model.trim().length > 0));
  }
  if (selection.kind !== 'router' || Object.keys(selection).some(key => !['kind', 'service', 'preferences', 'allowedModels'].includes(key))) return false;
  if (selection.allowedModels !== undefined && (!Array.isArray(selection.allowedModels) || selection.allowedModels.length > 512
    || selection.allowedModels.some(model => !model || typeof model !== 'object' || Array.isArray(model)
      || Object.keys(model).some(key => !['provider', 'serviceId'].includes(key))
      || typeof model.provider !== 'string' || !model.provider.trim() || model.provider.length > 128
      || typeof model.serviceId !== 'string' || !model.serviceId.trim() || model.serviceId.length > 256))) return false;
  try { assertRoutingPreferences(selection.preferences === undefined ? {} : selection.preferences); } catch { return false; }
  if (selection.service === undefined) return true;
  if (!selection.service || typeof selection.service !== 'object' || Array.isArray(selection.service)) return false;
  const service = selection.service as Record<string, unknown>;
  return Object.keys(service).every(key => ['peerId', 'provider', 'serviceId'].includes(key))
    && typeof service.peerId === 'string' && /^[0-9a-f]{40}$/.test(service.peerId)
    && typeof service.provider === 'string' && service.provider.trim().length > 0
    && typeof service.serviceId === 'string' && service.serviceId.trim().length > 0;
}
