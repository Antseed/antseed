import type { ServiceApiProtocol } from './service-api.js';

export const UNIT_BILLING_UNITS_V1 = [
  'output_images',
  'completed_requests',
  'video_generations',
  'video_seconds',
] as const;

export const UNIT_BILLING_MATCH_KEYS_V1 = [
  'model',
  'size',
  'quality',
  'resolution',
] as const;

export type UnitBillingUnitV1 = (typeof UNIT_BILLING_UNITS_V1)[number];
export type UnitBillingMatchKeyV1 = (typeof UNIT_BILLING_MATCH_KEYS_V1)[number];

export interface UnitBillingComponentV1 {
  unit: UnitBillingUnitV1;
  priceUsd: number;
  match?: Partial<Record<UnitBillingMatchKeyV1, string>>;
}

export interface UnitBillingModelV1 {
  version: 1;
  components: UnitBillingComponentV1[];
}

export type ServiceUnitBillingModelsV1 = Record<
  string,
  Partial<Record<ServiceApiProtocol, UnitBillingModelV1>>
>;

export interface UnitBillingUsage {
  units: Partial<Record<UnitBillingUnitV1, number>>;
}

export interface UnitBillingUsageReportV1 {
  version: 1;
  units: Partial<Record<UnitBillingUnitV1, string>>;
}

export interface UnitBillingContext {
  sellerPeerId: string;
  provider: string;
  service: string;
  serviceApiProtocol: ServiceApiProtocol;
  attributes?: Partial<Record<UnitBillingMatchKeyV1, string>>;
  unitLimits?: Partial<Record<UnitBillingUnitV1, number>>;
}

export const GENERATED_IMAGE_OUTPUT_UNIT_V1 = 'output_images' satisfies UnitBillingUnitV1;

export const FREE_UNIT_BILLING_MODEL_V1: UnitBillingModelV1 = {
  version: 1,
  components: [],
};

export const UNIT_BILLING_UNIT_SET_V1 = new Set<string>(UNIT_BILLING_UNITS_V1);
export const UNIT_BILLING_MATCH_KEY_SET_V1 = new Set<string>(UNIT_BILLING_MATCH_KEYS_V1);

export function isUnitBillingUnitV1(value: string): value is UnitBillingUnitV1 {
  return UNIT_BILLING_UNIT_SET_V1.has(value);
}

export function isUnitBillingMatchKeyV1(value: string): value is UnitBillingMatchKeyV1 {
  return UNIT_BILLING_MATCH_KEY_SET_V1.has(value);
}

export function isValidUnitBillingComponentV1(component: UnitBillingComponentV1): boolean {
  return isUnitBillingUnitV1(component.unit);
}

export function unitUsageToBillingReport(usage: UnitBillingUsage): UnitBillingUsageReportV1 {
  const units: Partial<Record<UnitBillingUnitV1, string>> = {};
  for (const [unit, count] of Object.entries(usage.units)) {
    if (!isUnitBillingUnitV1(unit) || count === undefined) continue;
    units[unit] = String(count);
  }
  return {
    version: 1,
    units,
  };
}

export function validateUnitBillingModelV1(model: UnitBillingModelV1): string[] {
  const errors: string[] = [];
  if (!model || typeof model !== 'object' || model.version !== 1 || !Array.isArray(model.components)) {
    return ['Unit billing model must be version 1 with a components array'];
  }
  model.components.forEach((component, index) => {
    if (!component || typeof component !== 'object') {
      errors.push(`components[${index}] must be an object`);
      return;
    }
    if (!isUnitBillingUnitV1(component.unit)) {
      errors.push(`components[${index}].unit is unsupported`);
    }
    if (!isValidUnitBillingComponentV1(component)) {
      errors.push(`components[${index}] must use a supported unit`);
    }
    if (!Number.isFinite(component.priceUsd) || component.priceUsd < 0) {
      errors.push(`components[${index}].priceUsd must be a non-negative finite number`);
    }
    if (component.match !== undefined) {
      if (!component.match || typeof component.match !== 'object' || Array.isArray(component.match)) {
        errors.push(`components[${index}].match must be an object`);
      } else {
        for (const [key, value] of Object.entries(component.match)) {
          if (!isUnitBillingMatchKeyV1(key)) {
            errors.push(`components[${index}].match.${key} is unsupported`);
          }
          if (typeof value !== 'string' || value.length === 0) {
            errors.push(`components[${index}].match.${key} must be a non-empty string`);
          }
        }
      }
    }
  });
  return errors;
}

export function isFreeUnitBillingModel(model: UnitBillingModelV1): boolean {
  return model.components.length === 0
    || model.components.every((component) => Number.isFinite(component.priceUsd) && component.priceUsd <= 0);
}

export function evaluateUnitBilling(
  model: UnitBillingModelV1,
  context: UnitBillingContext,
  usage: UnitBillingUsage,
): bigint {
  const validationErrors = validateUnitBillingModelV1(model);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid unit billing model: ${validationErrors.join('; ')}`);
  }

  let totalUsd = 0;
  const matchedUnits = new Set<UnitBillingUnitV1>();
  for (const component of model.components) {
    const unitCount = normalizedUnitCount(usage, component.unit);
    if (unitCount <= 0) continue;
    if (!componentMatchesContext(component, context)) continue;

    matchedUnits.add(component.unit);
    totalUsd += unitCount * component.priceUsd;
  }

  if (model.components.length > 0) {
    for (const unit of UNIT_BILLING_UNITS_V1) {
      if (normalizedUnitCount(usage, unit) > 0 && !matchedUnits.has(unit)) {
        throw new Error(`No billing component matched ${unit} for the request context`);
      }
    }
  }

  return usdToMicroUsdc(totalUsd);
}

export function validateUnitBillingUsageReportV1(report: UnitBillingUsageReportV1): string[] {
  const errors: string[] = [];
  if (!report || typeof report !== 'object' || report.version !== 1) {
    return ['Unit billing usage report must be version 1'];
  }
  if (!report.units || typeof report.units !== 'object' || Array.isArray(report.units)) {
    errors.push('units must be an object');
  } else {
    for (const [unit, value] of Object.entries(report.units)) {
      if (!isUnitBillingUnitV1(unit)) errors.push(`Unsupported billing unit "${unit}"`);
      if (typeof value !== 'string') {
        errors.push(`Unit "${unit}" must be encoded as a string`);
      } else {
        try {
          parseUnitCount(value, unit);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `Unit "${unit}" must be a safe non-negative integer decimal string`);
        }
      }
    }
  }
  return errors;
}

export function unitUsageFromReport(report: UnitBillingUsageReportV1): UnitBillingUsage {
  const units: Partial<Record<UnitBillingUnitV1, number>> = {};
  for (const [unit, value] of Object.entries(report.units)) {
    if (!isUnitBillingUnitV1(unit)) continue;
    units[unit] = parseUnitCount(value, unit);
  }
  return { units };
}

export function validateUnitBillingUsage(
  model: UnitBillingModelV1,
  context: UnitBillingContext,
  report: UnitBillingUsageReportV1,
  sellerCost: bigint,
  costToleranceMultiplier: number,
  observedUsage?: UnitBillingUsage,
): bigint {
  const errors = validateUnitBillingUsageReportV1(report);
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }

  const usage = unitUsageFromReport(report);
  validateUsageWithinRequestLimits(usage, context);
  if (observedUsage) {
    validateUsageWithinObservedUsage(usage, observedUsage);
  } else if (sellerCost > 0n) {
    throw new Error('Positive unit billing cost claimed before the buyer observed the delivered response');
  }
  const buyerEstimate = evaluateUnitBilling(model, context, usage);
  if (sellerCost > 0n && buyerEstimate <= 0n) {
    throw new Error('Positive unit billing cost recomputed to zero');
  }

  const maxAcceptable = BigInt(Math.ceil(Number(buyerEstimate) * costToleranceMultiplier));
  if (sellerCost > maxAcceptable) {
    throw new Error(`Seller unit billing cost ${sellerCost} exceeds buyer estimate ${buyerEstimate}`);
  }
  return buyerEstimate;
}

export function usdToMicroUsdc(value: number): bigint {
  return BigInt(Math.max(0, Math.round(value * 1_000_000)));
}

function parseUnitCount(value: string, unit: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Unit "${unit}" must be a canonical non-negative integer decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Unit "${unit}" exceeds the maximum safe integer`);
  }
  return Number(parsed);
}

function normalizedUnitCount(usage: UnitBillingUsage, unit: UnitBillingUnitV1): number {
  const value = usage.units[unit] ?? 0;
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function componentMatchesContext(component: UnitBillingComponentV1, context: UnitBillingContext): boolean {
  const match = component.match;
  if (!match || Object.keys(match).length === 0) return true;
  const requestAttributes = context.attributes ?? {};
  for (const [key, expected] of Object.entries(match) as Array<[UnitBillingMatchKeyV1, string]>) {
    if (requestAttributes[key] !== expected) return false;
  }
  return true;
}

function validateUsageWithinRequestLimits(usage: UnitBillingUsage, context: UnitBillingContext): void {
  for (const unit of UNIT_BILLING_UNITS_V1) {
    const limit = context.unitLimits?.[unit];
    const count = usage.units[unit];
    if (limit !== undefined && count !== undefined && count > limit) {
      throw new Error(`Seller reported ${unit}=${count} but request allowed ${limit}`);
    }
  }
}

function validateUsageWithinObservedUsage(usage: UnitBillingUsage, observed: UnitBillingUsage): void {
  for (const [unit, claimed] of Object.entries(usage.units)) {
    if (!isUnitBillingUnitV1(unit) || claimed === undefined || claimed <= 0) continue;
    const observedCount = observed.units[unit] ?? 0;
    if (claimed > observedCount) {
      throw new Error(`Seller reported ${unit}=${claimed} but response delivered ${observedCount}`);
    }
  }
}
