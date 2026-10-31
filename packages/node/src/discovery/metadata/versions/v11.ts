import { defineMetadataVersion, insertBefore, type MetadataLayout } from "../define-version.js";
import { providerLoadField } from "../fields/provider-basics.js";
import { serviceUnitBillingField } from "../fields/service-unit-billing.js";
import { V10_LAYOUT } from "./v10.js";

/** v11: per-service unit billing models. Decode-only. */
export const V11_LAYOUT: MetadataLayout = {
  providerFields: insertBefore(V10_LAYOUT.providerFields, providerLoadField, serviceUnitBillingField),
  peerFields: V10_LAYOUT.peerFields,
};

export const metadataV11 = defineMetadataVersion({ version: 11, wideServiceCounts: false, ...V11_LAYOUT });
