export {
  DHTNode,
  DEFAULT_DHT_CONFIG,
  topicToInfoHash,
  ANTSEED_WILDCARD_TOPIC,
  capabilityTopic,
  peerTopic,
  subnetTopic,
  subnetOf,
  SUBNET_COUNT,
  type DHTPeerEndpoint,
  type DHTNodeConfig,
} from './dht-node.js';
export { PeerAnnouncer, type AnnouncerConfig } from './announcer.js';
export { PeerLookup, DEFAULT_LOOKUP_CONFIG, type LookupConfig, type LookupResult } from './peer-lookup.js';

export { OFFICIAL_BOOTSTRAP_NODES, parseBootstrapList, mergeBootstrapNodes, toBootstrapConfig, type BootstrapNode } from './bootstrap.js';
export { encodeMetadata, encodeMetadataForSigning, decodeMetadata } from './metadata-codec.js';
export { validateMetadata, MAX_METADATA_SIZE, MAX_PROVIDERS, type ValidationError } from './metadata-validator.js';
export {
  METADATA_VERSION,
  WELL_KNOWN_SERVICE_CATEGORIES,
  type DomainVerificationClaim,
  type DomainVerificationMethod,
  type GithubVerificationClaim,
  type PeerMetadata,
  type PeerVerifications,
  type ProviderAnnouncement,
} from './peer-metadata.js';
export {
  DOMAIN_VERIFICATION_TXT_PREFIX,
  DOMAIN_VERIFICATION_TXT_NAME_PREFIX,
  DOMAIN_VERIFICATION_WELL_KNOWN_PATH,
  DOMAIN_VERIFICATION_WELL_KNOWN_TYPE,
  buildDomainVerificationTxtValue,
  buildDomainVerificationWellKnownProof,
  verifyDomainVerificationClaim,
  verifyPeerMetadataDomains,
  type DomainVerificationAttemptResult,
  type DomainVerificationOptions,
  type DomainVerificationResult,
} from './domain-verification.js';
export {
  GITHUB_VERIFICATION_PROOF_FILE,
  GITHUB_VERIFICATION_PROOF_TYPE,
  buildGithubVerificationProof,
  buildGithubVerificationProofUrl,
  verifyGithubVerificationClaim,
  verifyPeerMetadataGithub,
  type GithubVerificationOptions,
  type GithubVerificationResult,
} from './github-verification.js';
export {
  collectPeerVerificationLinks,
  isGithubName,
  isGithubRepository,
  type PeerVerificationLink,
} from './verification-links.js';
export { parsePublicAddress, MAX_PUBLIC_ADDRESS_LENGTH, type ParsedPublicAddress } from './public-address.js';
export { sanitizePeerDisplayName } from './display-name.js';
export { type MetadataResolver, type PeerEndpoint } from './metadata-resolver.js';
export { HttpMetadataResolver, MAX_METADATA_HTTP_RESPONSE_SIZE, type HttpMetadataResolverConfig } from './http-metadata-resolver.js';
export { DHTHealthMonitor, DEFAULT_HEALTH_THRESHOLDS, type DHTHealthSnapshot, type HealthThresholds } from './dht-health.js';
export {
  buildNetworkServiceOffers,
  compareNetworkServiceOfferPrice,
  inferServiceProtocol,
  resolveServiceProtocol,
  selectLowestPricedCanonicalOffers,
  selectLowestPricedNetworkServiceOffer,
  type CatalogServiceCapabilities,
  type CatalogServiceProtocol,
  type NetworkServiceCatalogPeer,
  type NetworkServiceOffer,
} from './service-catalog.js';
