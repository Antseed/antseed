import type { TokenPricingUsdPerMillion } from "../../peer-metadata.js";
import type { ProviderField } from "../field.js";
import { serviceMap } from "../wire.js";

/** [providerLen:1][provider:N] */
export const providerNameField: ProviderField = {
  key: "provider",
  encode(writer, provider) {
    writer.utf8Wrapping(provider.provider);
  },
  decode(reader, provider) {
    provider.provider = reader.utf8();
  },
};

/** [serviceCount:1|2][serviceLen:1][service:N]... — an empty list means "any service". */
export const servicesField: ProviderField = {
  key: "services",
  encode(writer, provider, ctx) {
    writer.serviceEntryCount(provider.services.length, ctx.wideServiceCounts);
    for (const service of provider.services) writer.utf8Wrapping(service);
  },
  decode(reader, provider, ctx) {
    const count = reader.serviceEntryCount(ctx.wideServiceCounts);
    const services: string[] = [];
    for (let i = 0; i < count; i += 1) services.push(reader.utf8());
    provider.services = services;
  },
};

function readPricing(reader: Parameters<ProviderField["decode"]>[0]): TokenPricingUsdPerMillion {
  const inputUsdPerMillion = reader.f32();
  const outputUsdPerMillion = reader.f32();
  const cachedInputUsdPerMillion = reader.f32();
  return {
    inputUsdPerMillion,
    outputUsdPerMillion,
    ...(cachedInputUsdPerMillion !== 0 ? { cachedInputUsdPerMillion } : {}),
  };
}

/** [input:f32][output:f32][cachedInput:f32] */
export const defaultPricingField: ProviderField = {
  key: "defaultPricing",
  encode(writer, provider) {
    writer.f32(provider.defaultPricing.inputUsdPerMillion);
    writer.f32(provider.defaultPricing.outputUsdPerMillion);
    writer.f32(provider.defaultPricing.cachedInputUsdPerMillion ?? 0);
  },
  decode(reader, provider) {
    provider.defaultPricing = readPricing(reader);
  },
};

/** [count:1|2] then [serviceLen:1][service:N][input:f32][output:f32][cachedInput:f32]... */
export const servicePricingField: ProviderField = {
  key: "servicePricing",
  encode(writer, provider, ctx) {
    // localeCompare predates the code-unit rule; changing it would change signed bytes.
    const entries = Object.entries(provider.servicePricing ?? {}).sort(([a], [b]) => a.localeCompare(b));
    writer.serviceEntryCount(entries.length, ctx.wideServiceCounts);
    for (const [service, pricing] of entries) {
      writer.utf8Wrapping(service);
      writer.f32(pricing.inputUsdPerMillion);
      writer.f32(pricing.outputUsdPerMillion);
      writer.f32(pricing.cachedInputUsdPerMillion ?? 0);
    }
  },
  decode(reader, provider, ctx) {
    const count = reader.serviceEntryCount(ctx.wideServiceCounts);
    if (count === 0) return;
    const servicePricing: Record<string, TokenPricingUsdPerMillion> = serviceMap();
    for (let i = 0; i < count; i += 1) {
      const service = reader.utf8();
      servicePricing[service] = readPricing(reader);
    }
    provider.servicePricing = servicePricing;
  },
};

/** [maxConcurrency:2][currentLoad:2] */
export const providerLoadField: ProviderField = {
  encode(writer, provider) {
    writer.u16(provider.maxConcurrency);
    writer.u16(provider.currentLoad);
  },
  decode(reader, provider) {
    provider.maxConcurrency = reader.u16();
    provider.currentLoad = reader.u16();
  },
};
