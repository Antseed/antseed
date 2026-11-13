import type { PeerOffering } from "../../../types/capability.js";
import type { PeerField } from "../field.js";

const PRICING_UNIT_IDS: Record<string, number> = { token: 0, request: 1, minute: 2, task: 3 };
const PRICING_UNITS_BY_ID: Array<PeerOffering["pricing"]["unit"]> = ["token", "request", "minute", "task"];

/**
 * [offeringCount:2] then [capLen:1][cap:N][nameLen:1][name:N][descLen:2][desc:N]
 * [unitId:1][pricePerUnit:f32][serviceCount:1]([serviceLen:1][service:N])...
 */
export const offeringsField: PeerField = {
  keys: ["offerings"],
  encode(writer, metadata) {
    const offerings = metadata.offerings ?? [];
    writer.u16(offerings.length);
    for (const offering of offerings) {
      writer.utf8Wrapping(offering.capability);
      writer.utf8Wrapping(offering.name);
      writer.utf8Long(offering.description);
      writer.u8(PRICING_UNIT_IDS[offering.pricing.unit] ?? 0);
      writer.f32(offering.pricing.pricePerUnit);
      const services = offering.services ?? [];
      writer.u8(services.length);
      for (const service of services) writer.utf8Wrapping(service);
    }
  },
  decode(reader, metadata) {
    // Older encoders could end the body before this block.
    if (reader.remaining() < 2) return;
    const count = reader.u16();
    const offerings: PeerOffering[] = [];
    for (let i = 0; i < count; i += 1) {
      const capability = reader.utf8() as PeerOffering["capability"];
      const name = reader.utf8();
      const description = reader.utf8Long();
      const unit = PRICING_UNITS_BY_ID[reader.u8()] ?? "token";
      const pricePerUnit = reader.f32();
      const serviceCount = reader.u8();
      const services: string[] = [];
      for (let j = 0; j < serviceCount; j += 1) services.push(reader.utf8());
      offerings.push({
        capability,
        name,
        description,
        services: services.length > 0 ? services : undefined,
        pricing: { unit, pricePerUnit, currency: "USD" },
      });
    }
    if (offerings.length > 0) metadata.offerings = offerings;
  },
};
