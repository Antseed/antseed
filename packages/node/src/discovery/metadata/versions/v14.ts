import { defineMetadataVersion, insertBefore, type MetadataLayout } from "../define-version.js";
import { providerLoadField } from "../fields/provider-basics.js";
import { servicePerformanceField } from "../fields/service-performance.js";
import { V13_LAYOUT } from "./v13.js";

/** v14: per-service performance the seller measured on its buyer traffic. */
export const V14_LAYOUT: MetadataLayout = {
  providerFields: insertBefore(V13_LAYOUT.providerFields, providerLoadField, servicePerformanceField),
  peerFields: V13_LAYOUT.peerFields,
};

export const metadataV14 = defineMetadataVersion({
  version: 14,
  wideServiceCounts: true,
  ...V14_LAYOUT,
  fromLatest: (latest) => latest,
});
