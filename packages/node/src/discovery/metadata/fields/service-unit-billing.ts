import type { ServiceApiProtocol } from "../../../types/service-api.js";
import { WELL_KNOWN_SERVICE_API_PROTOCOLS } from "../../../types/service-api.js";
import type {
  ServiceUnitBillingModelsV1,
  UnitBillingComponentV1,
  UnitBillingMatchKeyV1,
  UnitBillingModelV1,
  UnitBillingUnitV1,
} from "../../../types/billing.js";
import { UNIT_BILLING_MATCH_KEYS_V1, UNIT_BILLING_UNITS_V1 } from "../../../types/billing.js";
import type { ProviderField } from "../field.js";

const UNITS_BY_ID: UnitBillingUnitV1[] = [...UNIT_BILLING_UNITS_V1];
const UNIT_IDS = new Map<UnitBillingUnitV1, number>(UNITS_BY_ID.map((unit, index) => [unit, index]));
const MATCH_KEYS_BY_ID: UnitBillingMatchKeyV1[] = [...UNIT_BILLING_MATCH_KEYS_V1];
const MATCH_KEY_IDS = new Map<UnitBillingMatchKeyV1, number>(MATCH_KEYS_BY_ID.map((key, index) => [key, index]));

/**
 * [count:1|2] then per (service, protocol):
 * [serviceLen:1][service:N][protocolId:1][modelVersion:1][componentCount:1]
 * component: [unitId:1][priceUsd:f32][matchCount:1]([matchKeyId:1][valueLen:1][value:N])...
 */
export const serviceUnitBillingField: ProviderField = {
  key: "serviceUnitBillingModels",
  encode(writer, provider, ctx) {
    const entries: Array<[string, ServiceApiProtocol, UnitBillingModelV1]> = [];
    for (const [service, protocolModels] of Object.entries(provider.serviceUnitBillingModels ?? {})) {
      for (const protocol of WELL_KNOWN_SERVICE_API_PROTOCOLS) {
        const model = protocolModels?.[protocol];
        if (model) entries.push([service, protocol, model]);
      }
    }
    entries.sort(([serviceA, protocolA], [serviceB, protocolB]) =>
      serviceA === serviceB
        ? WELL_KNOWN_SERVICE_API_PROTOCOLS.indexOf(protocolA) - WELL_KNOWN_SERVICE_API_PROTOCOLS.indexOf(protocolB)
        : serviceA.localeCompare(serviceB),
    );
    writer.serviceEntryCount(entries.length, ctx.wideServiceCounts);
    for (const [service, protocol, model] of entries) {
      writer.utf8(service);
      writer.u8(WELL_KNOWN_SERVICE_API_PROTOCOLS.indexOf(protocol));
      writer.u8(model.version);
      writer.u8(model.components.length);
      for (const component of model.components) {
        writer.u8(UNIT_IDS.get(component.unit) ?? 255);
        writer.f32(component.priceUsd);
        const matchEntries = Object.entries(component.match ?? {})
          .filter((entry): entry is [UnitBillingMatchKeyV1, string] => MATCH_KEY_IDS.has(entry[0] as UnitBillingMatchKeyV1))
          .sort(([a], [b]) => (MATCH_KEY_IDS.get(a) ?? 0) - (MATCH_KEY_IDS.get(b) ?? 0));
        writer.u8(matchEntries.length);
        for (const [key, value] of matchEntries) {
          writer.u8(MATCH_KEY_IDS.get(key) ?? 255);
          writer.utf8(value);
        }
      }
    }
  },
  decode(reader, provider, ctx) {
    const count = reader.serviceEntryCount(ctx.wideServiceCounts);
    const models: ServiceUnitBillingModelsV1 = {};
    for (let i = 0; i < count; i += 1) {
      const service = reader.utf8();
      const protocol = WELL_KNOWN_SERVICE_API_PROTOCOLS[reader.u8()];
      if (!protocol) throw new Error("Unsupported service unit billing protocol id");
      const version = reader.u8();
      if (version !== 1) throw new Error(`Unsupported service unit billing model version ${version}`);
      const componentCount = reader.u8();
      const components: UnitBillingComponentV1[] = [];
      for (let j = 0; j < componentCount; j += 1) {
        const unit = UNITS_BY_ID[reader.u8()];
        if (!unit) throw new Error("Unsupported service unit billing component unit");
        const priceUsd = reader.f32();
        const matchCount = reader.u8();
        const match: Partial<Record<UnitBillingMatchKeyV1, string>> = {};
        for (let k = 0; k < matchCount; k += 1) {
          const key = MATCH_KEYS_BY_ID[reader.u8()];
          if (!key) throw new Error("Unsupported service unit billing match key");
          match[key] = reader.utf8();
        }
        components.push({ unit, priceUsd, ...(Object.keys(match).length > 0 ? { match } : {}) } as UnitBillingComponentV1);
      }
      models[service] = { ...(models[service] ?? {}), [protocol]: { version: 1, components } };
    }
    if (Object.keys(models).length > 0) provider.serviceUnitBillingModels = models;
  },
};
