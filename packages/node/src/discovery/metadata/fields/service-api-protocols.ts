import type { ServiceApiProtocol } from "../../../types/service-api.js";
import { isKnownServiceApiProtocol } from "../../../types/service-api.js";
import type { ProviderField } from "../field.js";
import { serviceMap } from "../wire.js";

/** [count:1|2] then [serviceLen:1][service:N][protocolCount:1][protocolLen:1][protocol:N]... */
export const serviceApiProtocolsField: ProviderField = {
  key: "serviceApiProtocols",
  encode(writer, provider, ctx) {
    const entries = Object.entries(provider.serviceApiProtocols ?? {})
      .map(([service, protocols]) => [
        service,
        Array.from(new Set(
          protocols
            .map((protocol) => protocol.trim().toLowerCase())
            .filter((protocol): protocol is ServiceApiProtocol => isKnownServiceApiProtocol(protocol)),
        )).sort(),
      ] as const)
      .filter(([, protocols]) => protocols.length > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    writer.serviceEntryCount(entries.length, ctx.wideServiceCounts);
    for (const [service, protocols] of entries) {
      writer.utf8Wrapping(service);
      writer.u8(protocols.length);
      for (const protocol of protocols) writer.utf8Wrapping(protocol);
    }
  },
  decode(reader, provider, ctx) {
    const count = reader.serviceEntryCount(ctx.wideServiceCounts);
    if (count === 0) return;
    const serviceApiProtocols: Record<string, ServiceApiProtocol[]> = serviceMap();
    for (let i = 0; i < count; i += 1) {
      const service = reader.utf8();
      const protocolCount = reader.u8();
      const protocols: ServiceApiProtocol[] = [];
      for (let j = 0; j < protocolCount; j += 1) protocols.push(reader.utf8() as ServiceApiProtocol);
      serviceApiProtocols[service] = protocols;
    }
    provider.serviceApiProtocols = serviceApiProtocols;
  },
};
