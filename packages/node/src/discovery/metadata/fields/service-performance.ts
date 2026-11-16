import type { ServicePerformance } from "../../peer-metadata.js";
import type { ProviderField } from "../field.js";
import { compareCodeUnits, serviceMap } from "../wire.js";

const HAS_FIRST_TOKEN_P50 = 1 << 0;
const HAS_FIRST_TOKEN_P90 = 1 << 1;
const HAS_TOKENS_PER_SECOND = 1 << 2;
const PRESENCE_MASK = (1 << 3) - 1;
/** The success rate goes on the wire in basis points. */
const RATE_SCALE = 10_000;

/**
 * [count:1|2] then [serviceLen:2][service:N][requests:4][successRateBps:2][presence:1]
 * [firstTokenMsP50:4?][firstTokenMsP90:4?][tokensPerSecondP50:2?]
 */
export const servicePerformanceField: ProviderField = {
  key: "servicePerformance",
  encode(writer, provider, ctx) {
    const entries = Object.entries(provider.servicePerformance ?? {}).sort(([a], [b]) => compareCodeUnits(a, b));
    writer.serviceEntryCount(entries.length, ctx.wideServiceCounts);
    for (const [service, performance] of entries) {
      writer.utf8(service);
      writer.u32(performance.requests);
      writer.u16(Math.round(performance.successRate * RATE_SCALE));
      let presence = 0;
      if (performance.firstTokenMsP50 !== undefined) presence |= HAS_FIRST_TOKEN_P50;
      if (performance.firstTokenMsP90 !== undefined) presence |= HAS_FIRST_TOKEN_P90;
      if (performance.tokensPerSecondP50 !== undefined) presence |= HAS_TOKENS_PER_SECOND;
      writer.u8(presence);
      if (performance.firstTokenMsP50 !== undefined) writer.u32(performance.firstTokenMsP50);
      if (performance.firstTokenMsP90 !== undefined) writer.u32(performance.firstTokenMsP90);
      if (performance.tokensPerSecondP50 !== undefined) writer.u16(performance.tokensPerSecondP50);
    }
  },
  decode(reader, provider, ctx) {
    const count = reader.serviceEntryCount(ctx.wideServiceCounts);
    const servicePerformance: Record<string, ServicePerformance> = serviceMap();
    for (let i = 0; i < count; i += 1) {
      const service = reader.utf8();
      const requests = reader.u32();
      const rateBps = reader.u16();
      if (rateBps > RATE_SCALE) throw new Error(`Service performance success rate ${rateBps} bps exceeds ${RATE_SCALE}`);
      const performance: ServicePerformance = { requests, successRate: rateBps / RATE_SCALE };
      const presence = reader.u8();
      if (presence & ~PRESENCE_MASK) {
        throw new Error(`Unknown service performance presence bits 0x${presence.toString(16)}`);
      }
      if (presence & HAS_FIRST_TOKEN_P50) performance.firstTokenMsP50 = reader.u32();
      if (presence & HAS_FIRST_TOKEN_P90) performance.firstTokenMsP90 = reader.u32();
      if (presence & HAS_TOKENS_PER_SECOND) performance.tokensPerSecondP50 = reader.u16();
      servicePerformance[service] = performance;
    }
    if (Object.keys(servicePerformance).length > 0) provider.servicePerformance = servicePerformance;
  },
};
