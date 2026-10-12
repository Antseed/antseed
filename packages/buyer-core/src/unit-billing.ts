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
  nativeVideoFacts,
  nativeVideoAcceptance,
  type NativeVideoFacts,
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
  unitUsageToBillingReport,
  validateUnitBillingModelV1,
} from '@antseed/protocol/billing';
import { NATIVE_VIDEO_PROTOCOLS, type ServiceApiProtocol } from '@antseed/protocol/service-api';

const ZERO_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  freshInputTokens: 0,
  cachedInputTokens: 0,
};

/** What a unit-billed request asked for, tagged by the kind of output it bills. */
export type BillingRequestFacts =
  | { kind: 'image'; image: ImageRequestFacts }
  | { kind: 'video'; video: NativeVideoFacts };

export interface CapturedUnitBillingContext {
  context: UnitBillingContext;
  requestUsage: UnitBillingUsage;
  requestFacts: BillingRequestFacts;
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
  request: SerializedHttpRequest;
}

export interface UnitBillingAdapter {
  name: string;
  units: readonly UnitBillingUnitV1[];
  protocols: readonly ServiceApiProtocol[];
  capture(args: CaptureUnitBillingArgs): CapturedUnitBillingContext;
  measure(
    response: SerializedHttpResponse,
    requestFacts: BillingRequestFacts,
  ): { usage: UnitBillingUsage; tokenUsage: TokenUsage };
}

const imageBillingAdapter: UnitBillingAdapter = {
  name: 'image billing',
  units: ['output_images'],
  protocols: ['openai-images'],
  capture: captureImageUnitBillingContext,
  measure: extractImageResponseUsage,
};

const videoBillingAdapter: UnitBillingAdapter = {
  name: 'video billing',
  units: ['video_generations', 'video_seconds'],
  protocols: NATIVE_VIDEO_PROTOCOLS,
  capture: captureVideoUnitBillingContext,
  measure: extractVideoResponseUsage,
};

function unimplementedUnitBillingAdapter(name: string, units: readonly UnitBillingUnitV1[]): UnitBillingAdapter {
  const fail = (): never => {
    throw new Error(`${name} is not implemented`);
  };
  return { name, units, protocols: [], capture: fail, measure: fail };
}

const UNIT_BILLING_ADAPTERS: readonly UnitBillingAdapter[] = [
  imageBillingAdapter,
  unimplementedUnitBillingAdapter('completed-request billing', ['completed_requests']),
  videoBillingAdapter,
];

function adapterForProtocol(protocol: ServiceApiProtocol): UnitBillingAdapter | undefined {
  return UNIT_BILLING_ADAPTERS.find((adapter) => adapter.protocols.includes(protocol));
}

function resolveUnitBillingAdapter(protocol: ServiceApiProtocol, model: UnitBillingModelV1): UnitBillingAdapter {
  const protocolAdapter = adapterForProtocol(protocol);
  if (!protocolAdapter) throw new Error(`Unit billing is not supported for ${protocol}`);
  for (const component of model.components) {
    const unitAdapter = UNIT_BILLING_ADAPTERS.find((adapter) => adapter.units.includes(component.unit));
    if (!unitAdapter) throw new Error(`No unit billing adapter for ${component.unit}`);
    if (unitAdapter.protocols.length === 0) throw new Error(`${unitAdapter.name} is not implemented`);
    if (unitAdapter !== protocolAdapter) throw new Error(`${component.unit} is not supported for ${protocol}`);
  }
  return protocolAdapter;
}

export function isUnitBilledProtocol(protocol: string | null | undefined): protocol is ServiceApiProtocol {
  return typeof protocol === 'string' && UNIT_BILLING_ADAPTERS.some((adapter) => adapter.protocols.includes(protocol as ServiceApiProtocol));
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
  return (adapterForProtocol(args.serviceApiProtocol) ?? imageBillingAdapter).capture(args);
}

function captureImageUnitBillingContext(args: CaptureUnitBillingArgs): CapturedUnitBillingContext {
  const parsed = extractRequestBodyFields(args.request.headers, args.request.body);
  const image = extractImageRequestFacts({
    path: args.request.path,
    method: args.request.method,
    body: parsed ?? undefined,
  });
  const requestUsage = imageUnitUsage(image);
  const attributes = imageAttributes(image);
  return {
    context: {
      sellerPeerId: args.sellerPeerId,
      provider: args.provider,
      service: args.service,
      serviceApiProtocol: args.serviceApiProtocol,
      ...(attributes ? { attributes } : {}),
      ...(image.requestedImages !== undefined
        ? { unitLimits: { output_images: image.requestedImages } }
        : {}),
    },
    requestUsage,
    requestFacts: { kind: 'image', image },
  };
}

function captureVideoUnitBillingContext(args: CaptureUnitBillingArgs): CapturedUnitBillingContext {
  const video = nativeVideoFacts(args.request);
  if (!video) throw new Error(`${args.serviceApiProtocol} billing requires a native video request`);
  const requestUsage = nativeVideoUnitUsage(video);
  return {
    context: {
      sellerPeerId: args.sellerPeerId,
      provider: args.provider,
      service: args.service,
      serviceApiProtocol: args.serviceApiProtocol,
      unitLimits: requestUsage.units,
      attributes: { model: args.service, ...(video.resolution ? { resolution: video.resolution } : {}) },
    },
    requestUsage,
    requestFacts: { kind: 'video', video },
  };
}

export function extractUnitResponseUsage(
  serviceApiProtocol: ServiceApiProtocol,
  response: SerializedHttpResponse,
  requestFacts: BillingRequestFacts,
): { usage: UnitBillingUsage; tokenUsage: TokenUsage } {
  const adapter = adapterForProtocol(serviceApiProtocol);
  if (!adapter) throw new Error(`Unit billing is not supported for ${serviceApiProtocol}`);
  return adapter.measure(response, requestFacts);
}

function wrongFacts(adapter: string, facts: BillingRequestFacts): never {
  throw new Error(`${adapter} cannot measure ${facts.kind} request facts`);
}

function extractVideoResponseUsage(
  response: SerializedHttpResponse,
  requestFacts: BillingRequestFacts,
): { usage: UnitBillingUsage; tokenUsage: TokenUsage } {
  if (requestFacts.kind !== 'video') return wrongFacts('video billing', requestFacts);
  const { video } = requestFacts;
  const accepted = nativeVideoAcceptance(video.protocol, response) !== null;
  return { usage: accepted ? nativeVideoUnitUsage(video) : { units: {} }, tokenUsage: ZERO_TOKEN_USAGE };
}

function extractImageResponseUsage(
  response: SerializedHttpResponse,
  requestFacts: BillingRequestFacts,
): { usage: UnitBillingUsage; tokenUsage: TokenUsage } {
  if (requestFacts.kind !== 'image') return wrongFacts('image billing', requestFacts);
  const parsed = parseJsonObject(response.body);
  const responseFacts: ProviderResponseFacts = parsed
    ? extractProviderResponseFacts(parsed)
    : { tokenUsage: ZERO_TOKEN_USAGE };
  const billableOutputImages = capOutputImagesToRequest(
    responseFacts.outputImages,
    requestFacts.image.requestedImages,
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
  requestFacts: BillingRequestFacts,
): FinalUnitBillingResult {
  const adapter = resolveUnitBillingAdapter(context.serviceApiProtocol, model);
  const responseUsage = adapter.measure(response, requestFacts);
  // Bill only units the seller priced, e.g. a per-generation video price
  // ignores the measured seconds.
  const usage = usageForModel(model, responseUsage.usage);
  const costUsdc = evaluateUnitBilling(model, context, usage);
  return {
    usage,
    tokenUsage: responseUsage.tokenUsage,
    costUsdc,
    billingUsage: unitUsageToBillingReport(usage),
  };
}

export function estimateUnitRequestCost(
  model: UnitBillingModelV1,
  context: UnitBillingContext,
  requestUsage: UnitBillingUsage,
): bigint {
  resolveUnitBillingAdapter(context.serviceApiProtocol, model);
  const usage = usageForModel(model, requestUsage);
  if (model.components.some((component) => component.unit === 'video_seconds')
    && (usage.units.video_seconds === undefined || usage.units.video_seconds <= 0)) {
    throw new Error('Explicit video duration is required for per-second pricing');
  }
  return evaluateUnitBilling(model, context, usage);
}

function usageForModel(model: UnitBillingModelV1, usage: UnitBillingUsage): UnitBillingUsage {
  const units: UnitBillingUsage['units'] = {};
  for (const component of model.components) {
    const count = usage.units[component.unit];
    if (count !== undefined) units[component.unit] = count;
  }
  return { units };
}

/** Units of one video job; status/download requests carry none. */
export function nativeVideoUnitUsage(video: NativeVideoFacts): UnitBillingUsage {
  if (video.action !== 'create') return { units: {} };
  return { units: { video_generations: 1, video_seconds: video.duration ?? 0 } };
}

function imageUnitUsage(facts: ImageRequestFacts): UnitBillingUsage {
  return {
    units: {
      ...(facts.requestedImages !== undefined ? { output_images: facts.requestedImages } : {}),
    },
  };
}

function imageAttributes(
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
