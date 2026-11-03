import { defineMetadataVersion, insertBefore, type MetadataLayout } from "../define-version.js";
import { providerLoadField } from "../fields/provider-basics.js";
import { serviceHealthField } from "../fields/service-health.js";
import { V12_LAYOUT } from "./v12.js";

/** v13: per-service seller self health check results. */
export const V13_LAYOUT: MetadataLayout = {
  providerFields: insertBefore(V12_LAYOUT.providerFields, providerLoadField, serviceHealthField),
  peerFields: V12_LAYOUT.peerFields,
};

export const metadataV13 = defineMetadataVersion({
  version: 13,
  wideServiceCounts: true,
  ...V13_LAYOUT,
  fromLatest: (latest) => latest,
});
