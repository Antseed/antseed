import type { ServiceUnitBillingModelsV1 } from '@antseed/node';
import {
  parseServiceCapabilitiesJson,
  parseServiceUnitBillingModelsJson,
} from '@antseed/provider-core';
import type { SellerServiceConfig } from './types.js';

const SYNTHETIC_SERVICE_ID = '__service__';

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

export function parseServiceCapabilitiesInput(
  raw: string,
  label = 'Service capabilities',
): NonNullable<SellerServiceConfig['capabilities']> {
  const parsed = parseJson(raw, label);
  const capabilities = parseServiceCapabilitiesJson(
    JSON.stringify({ [SYNTHETIC_SERVICE_ID]: parsed }),
    label,
  )?.[SYNTHETIC_SERVICE_ID];
  if (!capabilities) {
    throw new Error(`${label} must define at least one capability`);
  }
  return capabilities;
}

export function parseServiceUnitBillingModelsInput(
  raw: string,
  label = 'Service unit billing models',
): NonNullable<SellerServiceConfig['unitBillingModels']> {
  const parsed = parseJson(raw, label);
  const models = parseServiceUnitBillingModelsJson(
    JSON.stringify({ [SYNTHETIC_SERVICE_ID]: parsed }),
    label,
  )?.[SYNTHETIC_SERVICE_ID];
  if (!models) {
    throw new Error(`${label} must define at least one protocol model`);
  }
  return models;
}

export function validateServiceMetadata(
  path: string,
  service: Pick<SellerServiceConfig, 'capabilities' | 'unitBillingModels'>,
): string[] {
  const errors: string[] = [];
  if (service.capabilities !== undefined) {
    try {
      parseServiceCapabilitiesJson(
        JSON.stringify({ [SYNTHETIC_SERVICE_ID]: service.capabilities }),
        `${path}.capabilities`,
      );
    } catch (error) {
      errors.push((error as Error).message.replace(`.${SYNTHETIC_SERVICE_ID}`, ''));
    }
  }
  if (service.unitBillingModels !== undefined) {
    try {
      parseServiceUnitBillingModelsJson(
        JSON.stringify({ [SYNTHETIC_SERVICE_ID]: service.unitBillingModels } satisfies ServiceUnitBillingModelsV1),
        `${path}.unitBillingModels`,
      );
    } catch (error) {
      errors.push((error as Error).message.replace(`.${SYNTHETIC_SERVICE_ID}`, ''));
    }
  }
  return errors;
}
