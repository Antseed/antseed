import { validateRoutingPreferenceSchema, type RoutingPreferenceSchema } from '@antseed/protocol';

/** Supported models and settings a router plugin reports through `getCatalog()`. */
export type RoutingCatalogV1 = {
  version: 1;
  /** Opaque router-chosen identifier; echoed as `catalogRevision` on routing calls. */
  revision: string;
  title?: string;
  models: Array<{ provider: string; serviceId: string }>;
  preferencesSchema: RoutingPreferenceSchema;
};

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);

/** Plugins read catalogs from untrusted sources; check the shape before the buyer relies on it. */
export function validateRoutingCatalog(value: unknown): asserts value is RoutingCatalogV1 {
  const catalog = value as Partial<RoutingCatalogV1> | null;
  if (!catalog || typeof catalog !== 'object' || catalog.version !== 1 || !text(catalog.revision, 128)
    || (catalog.title !== undefined && !text(catalog.title, 128))
    || !Array.isArray(catalog.models) || catalog.models.length > 512
    || catalog.models.some(model => !model || !text(model.provider, 128) || !text(model.serviceId, 256))) {
    throw new Error('Invalid routing catalog');
  }
  validateRoutingPreferenceSchema(catalog.preferencesSchema);
}
