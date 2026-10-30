import type { ServiceHealth } from "../../peer-metadata.js";
import { SERVICE_HEALTH_REASONS, SERVICE_HEALTH_SOURCES, SERVICE_HEALTH_STATUSES } from "../../peer-metadata.js";
import type { ProviderField } from "../field.js";
import { compareCodeUnits, serviceMap } from "../wire.js";

const HAS_CHECKED_AT = 1 << 0;
const HAS_SOURCE = 1 << 1;
const HAS_FAILING_SINCE = 1 << 2;
const HAS_CONSECUTIVE_FAILURES = 1 << 3;
const HAS_REASON = 1 << 4;
const HAS_HTTP_STATUS = 1 << 5;
const PRESENCE_MASK = (1 << 6) - 1;

function enumId<T extends string>(values: readonly T[], value: T, label: string): number {
  const id = values.indexOf(value);
  if (id < 0) throw new Error(`Unsupported service health ${label} "${value}"`);
  return id;
}

function enumValue<T extends string>(values: readonly T[], id: number, label: string): T {
  const value = values[id];
  if (value === undefined) throw new Error(`Unsupported service health ${label} id ${id}`);
  return value;
}

/**
 * [count:1|2] then [serviceLen:1][service:N][statusId:1][presence:1]
 * [checkedAt:8?][sourceId:1?][failingSince:8?][consecutiveFailures:2?][reasonId:1?][httpStatus:2?]
 */
export const serviceHealthField: ProviderField = {
  key: "serviceHealth",
  encode(writer, provider, ctx) {
    const entries = Object.entries(provider.serviceHealth ?? {}).sort(([a], [b]) => compareCodeUnits(a, b));
    writer.serviceEntryCount(entries.length, ctx.wideServiceCounts);
    for (const [service, health] of entries) {
      writer.utf8(service);
      writer.u8(enumId(SERVICE_HEALTH_STATUSES, health.status, "status"));
      let presence = 0;
      if (health.checkedAt !== undefined) presence |= HAS_CHECKED_AT;
      if (health.source !== undefined) presence |= HAS_SOURCE;
      if (health.failingSince !== undefined) presence |= HAS_FAILING_SINCE;
      if (health.consecutiveFailures !== undefined) presence |= HAS_CONSECUTIVE_FAILURES;
      if (health.reason !== undefined) presence |= HAS_REASON;
      if (health.httpStatus !== undefined) presence |= HAS_HTTP_STATUS;
      writer.u8(presence);
      if (health.checkedAt !== undefined) writer.u64(health.checkedAt);
      if (health.source !== undefined) writer.u8(enumId(SERVICE_HEALTH_SOURCES, health.source, "source"));
      if (health.failingSince !== undefined) writer.u64(health.failingSince);
      if (health.consecutiveFailures !== undefined) writer.u16(health.consecutiveFailures);
      if (health.reason !== undefined) writer.u8(enumId(SERVICE_HEALTH_REASONS, health.reason, "reason"));
      if (health.httpStatus !== undefined) writer.u16(health.httpStatus);
    }
  },
  decode(reader, provider, ctx) {
    const count = reader.serviceEntryCount(ctx.wideServiceCounts);
    const serviceHealth: Record<string, ServiceHealth> = serviceMap();
    for (let i = 0; i < count; i += 1) {
      const service = reader.utf8();
      const health: ServiceHealth = { status: enumValue(SERVICE_HEALTH_STATUSES, reader.u8(), "status") };
      const presence = reader.u8();
      if (presence & ~PRESENCE_MASK) {
        throw new Error(`Unknown service health presence bits 0x${presence.toString(16)}`);
      }
      if (presence & HAS_CHECKED_AT) health.checkedAt = reader.u64();
      if (presence & HAS_SOURCE) health.source = enumValue(SERVICE_HEALTH_SOURCES, reader.u8(), "source");
      if (presence & HAS_FAILING_SINCE) health.failingSince = reader.u64();
      if (presence & HAS_CONSECUTIVE_FAILURES) health.consecutiveFailures = reader.u16();
      if (presence & HAS_REASON) health.reason = enumValue(SERVICE_HEALTH_REASONS, reader.u8(), "reason");
      if (presence & HAS_HTTP_STATUS) health.httpStatus = reader.u16();
      serviceHealth[service] = health;
    }
    if (Object.keys(serviceHealth).length > 0) provider.serviceHealth = serviceHealth;
  },
};
