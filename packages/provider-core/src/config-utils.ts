import type { Provider, ServiceApiProtocol, ServiceCapabilities, ServiceUnitBillingModelsV1, UnitBillingComponentV1, UnitBillingModelV1 } from '@antseed/node';
import { MAX_SERVICES_PER_PROVIDER, MAX_SERVICE_NAME_LENGTH, isKnownServiceApiProtocol, validateServiceCapabilityFields, validateUnitBillingModelForProtocolV1 } from '@antseed/node';

export function parseNonNegativeNumber(raw: string | undefined, key: string, fallback: number): number {
  const parsed = raw === undefined ? fallback : Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return parsed;
}

export function parseServicePricingJson(raw: string | undefined): Provider['pricing']['services'] {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('ANTSEED_SERVICE_PRICING_JSON must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ANTSEED_SERVICE_PRICING_JSON must be an object map of service -> pricing');
  }

  const out: NonNullable<Provider['pricing']['services']> = {};
  for (const [service, pricing] of Object.entries(parsed as Record<string, unknown>)) {
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
      throw new Error(`Service pricing for "${service}" must be an object`);
    }
    const input = (pricing as Record<string, unknown>)['inputUsdPerMillion'];
    const output = (pricing as Record<string, unknown>)['outputUsdPerMillion'];
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
      throw new Error(`Service pricing for "${service}" requires non-negative inputUsdPerMillion`);
    }
    if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
      throw new Error(`Service pricing for "${service}" requires non-negative outputUsdPerMillion`);
    }
    const cached = (pricing as Record<string, unknown>)['cachedInputUsdPerMillion'];
    if (cached != null && (typeof cached !== 'number' || !Number.isFinite(cached) || cached < 0)) {
      throw new Error(`Service pricing for "${service}" cachedInputUsdPerMillion must be a non-negative number`);
    }
    out[service] = {
      inputUsdPerMillion: input,
      outputUsdPerMillion: output,
      ...(typeof cached === 'number' ? { cachedInputUsdPerMillion: cached } : {}),
    };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseServiceUnitBillingModelsJson(raw: string | undefined, key = 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON'): ServiceUnitBillingModelsV1 | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${key} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${key} must be an object map of service -> protocol -> unit billing model`);
  }

  const out: ServiceUnitBillingModelsV1 = {};
  for (const [service, protocols] of Object.entries(parsed as Record<string, unknown>)) {
    if (!protocols || typeof protocols !== 'object' || Array.isArray(protocols)) {
      throw new Error(`${key}.${service} must be an object map of protocol -> unit billing model`);
    }
    for (const [protocol, model] of Object.entries(protocols as Record<string, unknown>)) {
      if (!isKnownServiceApiProtocol(protocol)) {
        throw new Error(`${key}.${service}.${protocol} must be a known service API protocol`);
      }
      if (!model || typeof model !== 'object' || Array.isArray(model)) {
        throw new Error(`${key}.${service}.${protocol} must be a unit billing model object`);
      }
      const normalized = normalizeUnitBillingModel(model as Record<string, unknown>, `${key}.${service}.${protocol}`);
      const errors = validateUnitBillingModelForProtocolV1(protocol, normalized);
      if (errors.length > 0) {
        throw new Error(`${key}.${service}.${protocol}: ${errors.join('; ')}`);
      }
      out[service] = {
        ...(out[service] ?? {}),
        [protocol]: normalized,
      } as ServiceUnitBillingModelsV1[string];
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeUnitBillingModel(raw: Record<string, unknown>, field: string): UnitBillingModelV1 {
  if (raw.version !== 1 || !Array.isArray(raw.components)) {
    throw new Error(`${field} must have version=1 and a components array`);
  }
  const components = raw.components.map((component, index): UnitBillingComponentV1 => {
    if (!component || typeof component !== 'object' || Array.isArray(component)) {
      throw new Error(`${field}.components[${index}] must be an object`);
    }
    const c = component as Record<string, unknown>;
    if (typeof c.unit !== 'string' || typeof c.priceUsd !== 'number') {
      throw new Error(`${field}.components[${index}] requires unit and numeric priceUsd`);
    }
    const match = c.match;
    return {
      unit: c.unit,
      priceUsd: c.priceUsd,
      ...(match && typeof match === 'object' && !Array.isArray(match) ? { match: match as Record<string, string> } : {}),
    } as UnitBillingComponentV1;
  });
  return { version: 1, components };
}

export function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
}

export function parseServiceCapabilitiesJson(raw: string | undefined, key = 'ANTSEED_SERVICE_CAPABILITIES_JSON'): Record<string, ServiceCapabilities> | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${key} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${key} must be an object map of service -> capabilities`);
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_SERVICES_PER_PROVIDER) {
    throw new Error(`${key} must not define more than ${MAX_SERVICES_PER_PROVIDER} services`);
  }
  const out: Record<string, ServiceCapabilities> = {};
  for (const [service, rawCaps] of entries) {
    if (service.length > MAX_SERVICE_NAME_LENGTH) {
      throw new Error(`${key} service name "${service}" exceeds ${MAX_SERVICE_NAME_LENGTH} characters`);
    }
    if (!rawCaps || typeof rawCaps !== 'object' || Array.isArray(rawCaps)) {
      throw new Error(`${key}.${service} must be a capabilities object`);
    }
    const caps = rawCaps as Record<string, unknown>;
    const normalized: ServiceCapabilities = {};
    for (const field of ['contextWindow', 'maxOutputTokens'] as const) {
      if (caps[field] !== undefined) normalized[field] = caps[field] as number;
    }
    if (caps.inputs !== undefined) normalized.inputs = caps.inputs as ServiceCapabilities['inputs'];
    if (caps.outputs !== undefined) normalized.outputs = caps.outputs as ServiceCapabilities['outputs'];
    for (const field of ['reasoning', 'toolUse', 'structuredOutput'] as const) {
      if (caps[field] !== undefined) normalized[field] = caps[field] as boolean;
    }
    if (caps.supportedParameters !== undefined) {
      normalized.supportedParameters = caps.supportedParameters as ServiceCapabilities['supportedParameters'];
    }
    // Same validator the announce path uses, so anything accepted here is
    // guaranteed to announce instead of failing silently at announce time.
    const fieldErrors = validateServiceCapabilityFields(normalized);
    if (fieldErrors.length > 0) {
      throw new Error(`${key}.${service}: ${fieldErrors.join('; ')}`);
    }
    if (Object.keys(normalized).length > 0) {
      out[service] = normalized;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseJsonObject(raw: string | undefined, key: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${key} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${key} must be a JSON object`);
  }

  return parsed as Record<string, unknown>;
}

export function buildServiceApiProtocols(
  services: string[],
  protocol: ServiceApiProtocol,
): Record<string, ServiceApiProtocol[]> | undefined {
  if (services.length === 0) return undefined;
  return Object.fromEntries(services.map((service) => [service, [protocol]]));
}

/**
 * Well-known image-generation model families. Shared by the openai plugin's
 * protocol classification and the seller setup wizard's capability prompts so
 * "what counts as an image model" cannot drift between the two.
 *
 * Match the final path segment so namespaced model IDs such as
 * `venice/flux-2-pro` work without treating an unrelated namespace as a model
 * family. Keep generic one-word IDs exact to avoid false positives.
 */
const IMAGE_MODEL_ID_PATTERN = /^(?:gpt-image-|dall-e(?:-|$)|grok-imagine-image(?:-|$)|venice-sd35$|krea-(?:2-|v2-)|flux-2-|hunyuan-image-|ideogram-v4(?:-|$)|imagineart-|luma-uni-|nano-banana-|recraft-v4(?:-|$)|seedream-v[45](?:-|$)|qwen-image(?:-|$)|wan-2-7(?:-pro)?-text-to-image$|lustify-|wai-illustrious$|z-image-|chroma$)/;

export function isImageModelId(model: string): boolean {
  const modelId = model.trim().toLowerCase().split('/').pop() ?? '';
  return IMAGE_MODEL_ID_PATTERN.test(modelId);
}
