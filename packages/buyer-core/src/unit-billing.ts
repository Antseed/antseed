import type {
  ImageRequestFacts,
  ProviderResponseFacts,
  TokenUsage,
} from '@antseed/api-adapter';
import {
  extractImageRequestFacts,
  extractProviderResponseFacts,
  extractRequestBodyFields,
  parseJsonObject,
} from '@antseed/api-adapter';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/protocol/http';
import type {
  UnitBillingContext,
  UnitBillingMatchKeyV1,
  UnitBillingModelV1,
  UnitBillingUnitV1,
  UnitBillingUsage,
  UnitBillingUsageReportV1,
} from '@antseed/protocol/billing';
import {
  evaluateUnitBilling,
  isCompletedRequestBillingModel,
  unitUsageToBillingReport,
  validateUnitBillingModelV1,
} from '@antseed/protocol/billing';
import type { ServiceApiProtocol } from '@antseed/protocol/service-api';

const ZERO_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  freshInputTokens: 0,
  cachedInputTokens: 0,
};

export interface CapturedUnitBillingContext {
  context: UnitBillingContext;
  requestUsage: UnitBillingUsage;
  requestFacts: ImageRequestFacts;
}

export interface FinalUnitBillingResult {
  usage: UnitBillingUsage;
  tokenUsage: TokenUsage;
  costUsdc: bigint;
  billingUsage: UnitBillingUsageReportV1;
}

export interface CaptureUnitBillingArgs {
  sellerPeerId: string;
  provider: string;
  service: string;
  serviceApiProtocol: ServiceApiProtocol;
  unitModel?: UnitBillingModelV1;
  request: SerializedHttpRequest;
}

export interface UnitBillingAdapter {
  name: string;
  units: readonly UnitBillingUnitV1[];
  protocols: readonly ServiceApiProtocol[] | 'any';
  capture(args: CaptureUnitBillingArgs): CapturedUnitBillingContext;
  measure(
    response: SerializedHttpResponse,
    requestFacts?: ImageRequestFacts,
    accepted?: boolean,
  ): { usage: UnitBillingUsage; tokenUsage: TokenUsage };
}

const imageBillingAdapter: UnitBillingAdapter = {
  name: 'image billing',
  units: ['output_images'],
  protocols: ['openai-images'],
  capture: captureImageUnitBillingContext,
  measure: extractImageResponseUsage,
};

export function completedRequestUsage(accepted: boolean): UnitBillingUsage {
  return { units: { completed_requests: accepted ? 1 : 0 } };
}

const completedRequestBillingAdapter: UnitBillingAdapter = {
  name: 'completed-request billing',
  units: ['completed_requests'],
  protocols: 'any',
  capture: (args) => ({
    context: {
      sellerPeerId: args.sellerPeerId,
      provider: args.provider,
      service: args.service,
      serviceApiProtocol: args.serviceApiProtocol,
      unitLimits: { completed_requests: 1 },
    },
    requestUsage: { units: { completed_requests: 1 } },
    requestFacts: {},
  }),
  measure(response, _requestFacts, accepted) {
    const ok = response.statusCode >= 200 && response.statusCode < 300;
    if (ok && accepted === undefined) throw new Error('Completed-request measurement requires response acceptance');
    return { usage: completedRequestUsage(ok && accepted === true), tokenUsage: { ...ZERO_TOKEN_USAGE } };
  },
};

function unimplementedUnitBillingAdapter(name: string, units: readonly UnitBillingUnitV1[]): UnitBillingAdapter {
  const fail = (): never => {
    throw new Error(`${name} is not implemented`);
  };
  return { name, units, protocols: [], capture: fail, measure: fail };
}

const UNIT_BILLING_ADAPTERS: readonly UnitBillingAdapter[] = [
  imageBillingAdapter,
  completedRequestBillingAdapter,
  unimplementedUnitBillingAdapter('video billing', ['video_generations', 'video_seconds']),
];

function adapterForProtocol(protocol: ServiceApiProtocol): UnitBillingAdapter | undefined {
  return UNIT_BILLING_ADAPTERS.find((adapter) => adapter.protocols !== 'any' && adapter.protocols.includes(protocol));
}

function resolveUnitBillingAdapter(protocol: ServiceApiProtocol | undefined, model: UnitBillingModelV1): UnitBillingAdapter {
  let resolved: UnitBillingAdapter | undefined;
  for (const component of model.components) {
    const unitAdapter = UNIT_BILLING_ADAPTERS.find((adapter) => adapter.units.includes(component.unit));
    if (!unitAdapter) throw new Error(`No unit billing adapter for ${component.unit}`);
    if (unitAdapter.protocols.length === 0) throw new Error(`${unitAdapter.name} is not implemented`);
    if (unitAdapter.protocols !== 'any' && (!protocol || !unitAdapter.protocols.includes(protocol))) {
      throw new Error(`${component.unit} is not supported for ${protocol ?? 'an unspecified protocol'}`);
    }
    if (resolved && resolved !== unitAdapter) throw new Error(`${component.unit} cannot be combined with ${resolved.units.join(', ')}`);
    resolved = unitAdapter;
  }
  resolved ??= protocol ? adapterForProtocol(protocol) : undefined;
  if (!resolved) throw new Error(`Unit billing is not supported for ${protocol ?? 'an unspecified protocol'}`);
  return resolved;
}

export function isUnitBilledProtocol(protocol: string | null | undefined): protocol is ServiceApiProtocol {
  return typeof protocol === 'string' && adapterForProtocol(protocol as ServiceApiProtocol) !== undefined;
}

export function validateUnitBillingModelForProtocolV1(
  protocol: ServiceApiProtocol,
  model: UnitBillingModelV1,
): string[] {
  const errors = validateUnitBillingModelV1(model);
  if (errors.length > 0) return errors;
  try {
    resolveUnitBillingAdapter(protocol, model);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

export function captureUnitBillingContext(args: CaptureUnitBillingArgs): CapturedUnitBillingContext {
  const adapter = args.unitModel && isCompletedRequestBillingModel(args.unitModel)
    ? completedRequestBillingAdapter
    : adapterForProtocol(args.serviceApiProtocol) ?? imageBillingAdapter;
  return adapter.capture(args);
}

function captureImageUnitBillingContext(args: CaptureUnitBillingArgs): CapturedUnitBillingContext {
  const parsed = extractRequestBodyFields(args.request.headers, args.request.body);
  const requestFacts = extractImageRequestFacts({
    path: args.request.path,
    method: args.request.method,
    body: parsed ?? undefined,
  });
  const requestUsage = factsToUnitUsage(requestFacts);
  const attributes = factsToAttributes(requestFacts);
  return {
    context: {
      sellerPeerId: args.sellerPeerId,
      provider: args.provider,
      service: args.service,
      serviceApiProtocol: args.serviceApiProtocol,
      ...(attributes ? { attributes } : {}),
      ...(requestFacts.requestedImages !== undefined
        ? { unitLimits: { output_images: requestFacts.requestedImages } }
        : {}),
    },
    requestUsage,
    requestFacts,
  };
}

export function extractUnitResponseUsage(
  response: SerializedHttpResponse,
  requestFacts?: ImageRequestFacts,
  serviceApiProtocol: ServiceApiProtocol = 'openai-images',
): { usage: UnitBillingUsage; tokenUsage: TokenUsage } {
  return (adapterForProtocol(serviceApiProtocol) ?? imageBillingAdapter).measure(response, requestFacts);
}

function extractImageResponseUsage(
  response: SerializedHttpResponse,
  requestFacts?: ImageRequestFacts,
): { usage: UnitBillingUsage; tokenUsage: TokenUsage } {
  const parsed = parseJsonObject(response.body);
  const responseFacts: ProviderResponseFacts = parsed
    ? extractProviderResponseFacts(parsed)
    : { tokenUsage: ZERO_TOKEN_USAGE };
  const billableOutputImages = capOutputImagesToRequest(
    responseFacts.outputImages,
    requestFacts?.requestedImages,
  );
  return {
    usage: {
      units: {
        ...(billableOutputImages !== undefined ? { output_images: billableOutputImages } : {}),
      },
    },
    tokenUsage: responseFacts.tokenUsage,
  };
}

export function computeFinalUnitBilling(
  model: UnitBillingModelV1,
  context: UnitBillingContext,
  response: SerializedHttpResponse,
  requestFacts?: ImageRequestFacts,
  accepted?: boolean,
): FinalUnitBillingResult {
  const responseUsage = resolveUnitBillingAdapter(context.serviceApiProtocol, model).measure(response, requestFacts, accepted);
  const costUsdc = evaluateUnitBilling(model, context, responseUsage.usage);
  return {
    usage: responseUsage.usage,
    tokenUsage: responseUsage.tokenUsage,
    costUsdc,
    billingUsage: unitUsageToBillingReport(responseUsage.usage),
  };
}

export function estimateUnitRequestCost(
  model: UnitBillingModelV1,
  context: UnitBillingContext,
  requestUsage: UnitBillingUsage,
): bigint {
  resolveUnitBillingAdapter(context.serviceApiProtocol, model);
  return evaluateUnitBilling(model, context, requestUsage);
}

function factsToUnitUsage(facts: ImageRequestFacts): UnitBillingUsage {
  return {
    units: {
      ...(facts.requestedImages !== undefined ? { output_images: facts.requestedImages } : {}),
    },
  };
}

function factsToAttributes(
  facts: ImageRequestFacts,
): Partial<Record<UnitBillingMatchKeyV1, string>> | undefined {
  const attributes: Partial<Record<UnitBillingMatchKeyV1, string>> = {};
  for (const key of ['model', 'size', 'quality', 'resolution'] as const) {
    const value = facts[key];
    if (value !== undefined) attributes[key] = value;
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function capOutputImagesToRequest(
  outputImages: number | undefined,
  requestedImages: number | undefined,
): number | undefined {
  if (outputImages === undefined || requestedImages === undefined) {
    return outputImages;
  }
  return Math.min(outputImages, requestedImages);
}
