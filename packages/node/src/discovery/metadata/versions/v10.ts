import { defineMetadataVersion, type MetadataLayout } from "../define-version.js";
import { offeringsField } from "../fields/offerings.js";
import { onChainStatsField } from "../fields/on-chain-stats.js";
import { peerCapabilitiesField } from "../fields/peer-capabilities.js";
import { displayNameField, publicAddressField, sellerContractField } from "../fields/peer-profile.js";
import {
  defaultPricingField,
  providerLoadField,
  providerNameField,
  servicePricingField,
  servicesField,
} from "../fields/provider-basics.js";
import { serviceApiProtocolsField } from "../fields/service-api-protocols.js";
import { serviceCategoriesField } from "../fields/service-categories.js";
import { verificationsField } from "../fields/verifications.js";

/** v10: peer capabilities. The oldest version buyers accept. Decode-only. */
export const V10_LAYOUT: MetadataLayout = {
  providerFields: [
    providerNameField,
    servicesField,
    defaultPricingField,
    servicePricingField,
    serviceCategoriesField,
    serviceApiProtocolsField,
    providerLoadField,
  ],
  peerFields: [
    displayNameField,
    publicAddressField,
    sellerContractField,
    verificationsField,
    offeringsField,
    onChainStatsField,
    peerCapabilitiesField,
  ],
};

export const metadataV10 = defineMetadataVersion({ version: 10, wideServiceCounts: false, ...V10_LAYOUT });
