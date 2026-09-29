import type { Identity } from "../p2p/identity.js";
import { signData } from "../p2p/identity.js";
import type { DHTNode } from "./dht-node.js";
import {
  ANTSEED_WILDCARD_TOPIC,
  capabilityTopic,
  peerTopic,
  subnetOf,
  subnetTopic,
  topicToInfoHash,
} from "./dht-node.js";
import type { PeerOffering } from "../types/capability.js";
import type { DomainVerificationClaim, DomainVerificationMethod, GithubVerificationClaim, PeerMetadata, PeerVerifications, ProviderAnnouncement, ServiceCapabilities } from "./peer-metadata.js";
import { METADATA_VERSION } from "./peer-metadata.js";
import {
  MAX_DOMAIN_LENGTH,
  MAX_DOMAIN_VERIFICATION_CLAIMS,
  MAX_GITHUB_REPOSITORY_LENGTH,
  MAX_GITHUB_USERNAME_LENGTH,
  MAX_GITHUB_VERIFICATION_CLAIMS,
  validateMetadata,
} from "./metadata-validator.js";

import type { ServiceApiProtocol } from "../types/service-api.js";
import { isKnownServiceApiProtocol } from "../types/service-api.js";
import type { ServiceUnitBillingModelsV1 } from "../types/billing.js";
import { encodeMetadataForSigning } from "./metadata-codec.js";
import { getAddress } from "ethers";
import { debugWarn } from "../utils/debug.js";
import { bytesToHex } from "../utils/hex.js";
import type { StakingClient } from "../payments/evm/staking-client.js";
import type { ChannelsClient } from "../payments/evm/channels-client.js";
import type { DHTHealthMonitor } from "./dht-health.js";
import {
  CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1,
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1,
  CONNECTION_CAPABILITY_SIGNED_SDP_V1,
  CONNECTION_CAPABILITY_TCP_ENC_V1,
} from "../types/protocol.js";

export interface SellerContractConfig {
  /**
   * On-chain seller contract that fronts this peer (e.g. DiemStakingProxy).
   * Buyers verify the peer→contract binding by calling
   * `sellerContract.isOperator(peerAddress)`. The peer's identity wallet must
   * be an authorized operator on the contract.
   */
  sellerContract: string;
}

export interface AnnouncerConfig {
  identity: Identity;
  dht: DHTNode;
  providers: Array<{
    provider: string;
    services: string[];
    serviceCategories?: Record<string, string[]>;
    serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
    serviceUnitBillingModels?: ServiceUnitBillingModelsV1;
    serviceCapabilities?: Record<string, ServiceCapabilities>;
    maxConcurrency: number;
    /** Runtime availability predicate. Unavailable providers are omitted. */
    isAvailable?: () => boolean;
    /** Per-instance pricing. Takes precedence over the shared pricing Map. */
    pricing?: {
      defaults: { inputUsdPerMillion: number; outputUsdPerMillion: number };
      services?: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }>;
    };
  }>;
  displayName?: string;
  publicAddress?: string;
  /** External ownership claims to include in signed metadata for client verification. */
  verifications?: PeerVerifications;
  region: string;
  pricing: Map<
    string,
    {
      defaults: { inputUsdPerMillion: number; outputUsdPerMillion: number };
      services?: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }>;
    }
  >;
  offerings?: PeerOffering[];
  stakeAmountUSDC?: number;
  paymentsEnabled?: boolean;
  channelsClient?: ChannelsClient;
  stakingClient?: StakingClient;
  reannounceIntervalMs: number;
  signalingPort: number;
  /** Extra peer capability strings to advertise (merged with the built-in set). */
  capabilities?: string[];
  /** Optional health monitor — if supplied, announce outcomes are recorded. */
  healthMonitor?: DHTHealthMonitor;
  /**
   * Optional on-chain seller contract (e.g. DiemStakingProxy). When set, the
   * announcer publishes it in metadata; buyers verify the binding via
   * `sellerContract.isOperator(peerAddress)`.
   */
  sellerContract?: SellerContractConfig;
  /** Whether this seller currently supports buyer deposit sweep relaying. */
  relaysSweeps?: boolean;
}

/**
 * Retry schedule when one or more topic announces fail. Short backoffs let
 * a seller recover from transient DHT hiccups before buyers decide the peer
 * has disappeared (buyer staleness cutoff is 30 min).
 */
const ANNOUNCE_RETRY_BACKOFFS_MS = [60_000, 120_000, 300_000, 600_000];

export class PeerAnnouncer {
  private readonly config: AnnouncerConfig;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private retryHandle: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private stopped = false;
  private readonly loadMap: Map<string, number> = new Map();
  private _latestMetadata: PeerMetadata | null = null;

  constructor(config: AnnouncerConfig) {
    this.config = config;
  }

  async announce(): Promise<void> {
    this._latestMetadata = await this._buildSignedMetadata(true);

    const failures = await this._announceTopics();
    if (failures > 0) {
      this._scheduleRetryAfterFailure(failures);
    } else {
      // Recovered — cancel any pending retry and reset backoff.
      this._cancelRetry();
    }
  }

  /**
   * Refresh signed metadata snapshot without announcing to DHT.
   * Useful for high-frequency fields like current provider load.
   */
  async refreshMetadata(): Promise<void> {
    this._latestMetadata = await this._buildSignedMetadata(false);
  }

  startPeriodicAnnounce(): void {
    if (this.intervalHandle) {
      return;
    }
    this.stopped = false;
    // Announce immediately, then on interval
    void this.announce().catch((err) => {
      debugWarn(`[Announcer] Initial announce failed: ${err instanceof Error ? err.message : err}`);
    });
    this.intervalHandle = setInterval(() => {
      void this.announce().catch((err) => {
        debugWarn(`[Announcer] Periodic announce failed: ${err instanceof Error ? err.message : err}`);
      });
    }, this.config.reannounceIntervalMs);
  }

  stopPeriodicAnnounce(): void {
    this.stopped = true;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this._cancelRetry();
  }

  private _cancelRetry(): void {
    if (this.retryHandle) {
      clearTimeout(this.retryHandle);
      this.retryHandle = null;
    }
    this.retryAttempt = 0;
  }

  private _scheduleRetryAfterFailure(failures: number): void {
    if (this.stopped || this.retryHandle) {
      // Already stopped, or a retry is already scheduled — don't arm a new timer.
      return;
    }
    const idx = Math.min(this.retryAttempt, ANNOUNCE_RETRY_BACKOFFS_MS.length - 1);
    const delayMs = Math.min(
      ANNOUNCE_RETRY_BACKOFFS_MS[idx] ?? ANNOUNCE_RETRY_BACKOFFS_MS[ANNOUNCE_RETRY_BACKOFFS_MS.length - 1]!,
      // Never wait longer than the next periodic cycle — the interval will retry anyway.
      this.config.reannounceIntervalMs,
    );
    this.retryAttempt += 1;
    debugWarn(
      `[Announcer] ${failures} topic announce(s) failed; retry #${this.retryAttempt} in ${Math.round(delayMs / 1000)}s`,
    );
    this.retryHandle = setTimeout(() => {
      this.retryHandle = null;
      void this.announce().catch((err) => {
        debugWarn(`[Announcer] Retry announce failed: ${err instanceof Error ? err.message : err}`);
      });
    }, delayMs);
  }

  updateLoad(providerName: string, currentLoad: number): void {
    this.loadMap.set(providerName, currentLoad);
  }

  getLatestMetadata(): PeerMetadata | null {
    return this._latestMetadata;
  }

  /** Return the configured seller contract as lowercase 40-hex (no 0x). */
  private _normalizedSellerContract(): string | undefined {
    const cfg = this.config.sellerContract;
    if (!cfg) return undefined;
    return cfg.sellerContract.toLowerCase().replace(/^0x/, "");
  }

  private _normalizedVerifications(): PeerVerifications | undefined {
    const claims = this.config.verifications?.domains ?? [];
    const domains: DomainVerificationClaim[] = [];
    const seen = new Set<string>();
    const methodOrder: DomainVerificationMethod[] = ["dns-txt", "https-well-known"];
    for (const claim of claims) {
      const normalizedDomain = claim.domain.trim().toLowerCase();
      if (!normalizedDomain || normalizedDomain.length > MAX_DOMAIN_LENGTH || seen.has(normalizedDomain)) continue;
      seen.add(normalizedDomain);
      const methods = claim.methods
        ? methodOrder.filter((method) => claim.methods!.includes(method))
        : undefined;
      domains.push({
        domain: normalizedDomain,
        ...(methods && methods.length > 0 ? { methods } : {}),
      });
    }
    // Code-unit sorts (matching the codec) so signed claim order is locale-independent.
    domains.sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));

    const githubClaims = this.config.verifications?.github ?? [];
    const github: GithubVerificationClaim[] = [];
    const seenGithub = new Set<string>();
    for (const claim of githubClaims) {
      const username = claim.username.trim().toLowerCase();
      const repository = claim.repository ? claim.repository.trim().toLowerCase() : "";
      const key = `${username}/${repository}`;
      if (!username || username.length > MAX_GITHUB_USERNAME_LENGTH) continue;
      if (repository.length > MAX_GITHUB_REPOSITORY_LENGTH || seenGithub.has(key)) continue;
      seenGithub.add(key);
      github.push({
        username,
        ...(repository ? { repository } : {}),
      });
    }
    github.sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1
      : (a.repository ?? "") < (b.repository ?? "") ? -1 : (a.repository ?? "") > (b.repository ?? "") ? 1 : 0));

    if (domains.length === 0 && github.length === 0) return undefined;
    return {
      ...(domains.length > 0 ? { domains: domains.slice(0, MAX_DOMAIN_VERIFICATION_CLAIMS) } : {}),
      ...(github.length > 0 ? { github: github.slice(0, MAX_GITHUB_VERIFICATION_CLAIMS) } : {}),
    };
  }

  private async _buildSignedMetadata(includeOnChainReputation = true): Promise<PeerMetadata> {
    const providers: ProviderAnnouncement[] = this.config.providers
      .filter((provider) => provider.isAvailable?.() !== false)
      .map((p) => {
        const pricing = p.pricing ?? this.config.pricing.get(p.provider) ?? {
          defaults: {
            inputUsdPerMillion: 0,
            outputUsdPerMillion: 0,
          },
        };
        const providerAnnouncement: ProviderAnnouncement = {
          provider: p.provider,
          services: p.services,
          defaultPricing: pricing.defaults,
          maxConcurrency: p.maxConcurrency,
          currentLoad: this.loadMap.get(p.provider) ?? 0,
        };
        if (pricing.services) {
          providerAnnouncement.servicePricing = pricing.services;
        }
        const normalizedServiceCategories = this._normalizeServiceCategories(p.serviceCategories, p.services);
        if (normalizedServiceCategories) {
          providerAnnouncement.serviceCategories = normalizedServiceCategories;
        }
        const normalizedServiceApiProtocols = this._normalizeServiceApiProtocols(p.serviceApiProtocols, p.services);
        if (normalizedServiceApiProtocols) {
          providerAnnouncement.serviceApiProtocols = normalizedServiceApiProtocols;
        }
        const normalizedServiceUnitBillingModels = this._normalizeServiceUnitBillingModels(p.serviceUnitBillingModels, p.services);
        if (normalizedServiceUnitBillingModels) {
          providerAnnouncement.serviceUnitBillingModels = normalizedServiceUnitBillingModels;
        }
        const normalizedServiceCapabilities = this._normalizeServiceCapabilities(p.serviceCapabilities, p.services);
        if (normalizedServiceCapabilities) {
          providerAnnouncement.serviceCapabilities = normalizedServiceCapabilities;
        }
        return providerAnnouncement;
      });

    const capabilities: string[] = [
      CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
      CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1,
      CONNECTION_CAPABILITY_SIGNED_SDP_V1,
      CONNECTION_CAPABILITY_TCP_ENC_V1,
    ];
    if (this.config.relaysSweeps) {
      capabilities.push(CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1);
    }
    if (this.config.capabilities && this.config.capabilities.length > 0) {
      capabilities.push(...this.config.capabilities);
    }

    const timestamp = Date.now();
    let onChainChannelCount: number | undefined;
    let onChainGhostCount: number | undefined;
    const verifications = this._normalizedVerifications();

    if (this.config.paymentsEnabled) {
      if (includeOnChainReputation && this.config.channelsClient && this.config.stakingClient) {
        try {
          // When the peer is fronted by a seller contract (e.g. DiemStakingProxy),
          // the on-chain seller is the proxy — stake and channel stats live under
          // that address, not the peer's wallet.
          const rawSellerAddress = this.config.sellerContract?.sellerContract
            ?? this.config.identity.wallet.address;
          const sellerAddress = getAddress(
            rawSellerAddress.startsWith("0x") ? rawSellerAddress : "0x" + rawSellerAddress,
          );
          const agentId = await this.config.stakingClient.getAgentId(sellerAddress);
          const stats = await this.config.channelsClient.getAgentStats(agentId);
          onChainChannelCount = stats.channelCount;
          onChainGhostCount = stats.ghostCount;
        } catch {
          // Channels/staking contract lookup failed — skip on-chain stats for this cycle
        }
      } else {
        onChainChannelCount = this._latestMetadata?.onChainChannelCount;
        onChainGhostCount = this._latestMetadata?.onChainGhostCount;
      }
    }

    const sellerContract = this._normalizedSellerContract();

    return this._signAndValidateMetadata({
      peerId: this.config.identity.peerId,
      version: METADATA_VERSION,
      ...(this.config.displayName ? { displayName: this.config.displayName } : {}),
      ...(this.config.publicAddress ? { publicAddress: this.config.publicAddress } : {}),
      providers,
      capabilities,
      region: this.config.region,
      timestamp,
      ...(this.config.offerings && this.config.offerings.length > 0 ? { offerings: this.config.offerings } : {}),
      ...(this.config.stakeAmountUSDC != null ? { stakeAmountUSDC: this.config.stakeAmountUSDC } : {}),
      ...(verifications ? { verifications } : {}),
      ...(onChainChannelCount !== undefined ? { onChainChannelCount } : {}),
      ...(onChainGhostCount !== undefined ? { onChainGhostCount } : {}),
      ...(sellerContract ? { sellerContract } : {}),
      signature: "",
    });
  }

  private _signAndValidateMetadata(metadata: PeerMetadata): PeerMetadata {
    const dataToSign = encodeMetadataForSigning(metadata);
    const signature = signData(this.config.identity.wallet, dataToSign);
    const signedMetadata: PeerMetadata = {
      ...metadata,
      signature: bytesToHex(signature),
    };
    const errors = validateMetadata(signedMetadata);
    if (errors.length > 0) {
      throw new Error(`Invalid metadata snapshot: ${errors.map((error) => `${error.field}: ${error.message}`).join("; ")}`);
    }
    return signedMetadata;
  }

  /**
   * Announce the topics that let buyers discover this peer.
   *
   * Topics are intentionally O(1) in the seller's service count. Service
   * filtering is metadata-driven: the signed metadata document carries the
   * full service catalog (`providers[].services`, `providerPricing.services`,
   * `providerServiceCategories`, `providerServiceApiProtocols`), and buyers
   * filter against that after enumeration. Announcing a per-service topic
   * once gave us topic-targeted discovery, but: (a) the proxy never used it,
   * (b) the CLI already filtered metadata-side anyway, (c) the existing
   * "empty service-topic → fall back to wildcard" path made it best-effort,
   * and (d) it grew the announce cycle linearly with services and recreated
   * the K-closest saturation problem on every popular service infohash.
   *
   * All topics are published in parallel — each announce is independent
   * (separate K-closest fan-out per infohash) and they share no state, so
   * sequencing them just slows the reannounce cycle for no benefit.
   */
  private async _announceTopics(): Promise<number> {
    const subnet = subnetOf(this.config.identity.peerId);
    const topics = new Set<string>();

    // Subnet topic: shards the peer set across SUBNET_COUNT infohashes so no
    // single one carries every announcer at once. Buyers fan out parallel
    // lookups across all subnets in `PeerLookup.findAll()`.
    topics.add(subnetTopic(subnet));

    // Wildcard remains during the transition: it lets older buyers (still on
    // the single-infohash scan) keep finding this peer. Once subnet-aware
    // buyers are universal it can be dropped — see SUBNET_COUNT comment in
    // dht-node.ts.
    topics.add(ANTSEED_WILDCARD_TOPIC);

    // Per-peer topic: lets buyers do a deterministic lookup-by-peerId without
    // scanning the wildcard or any subnet.
    topics.add(peerTopic(this.config.identity.peerId));

    if (this.config.offerings) {
      for (const offering of this.config.offerings) {
        topics.add(capabilityTopic(offering.capability, offering.name));
        const normalizedCapability = offering.capability.trim().toLowerCase();
        if (normalizedCapability) {
          topics.add(capabilityTopic(normalizedCapability));
        }
      }
    }

    const results = await Promise.allSettled(
      [...topics].map((topic) => this._tryAnnounceTopic(topic)),
    );
    let failures = 0;
    for (const r of results) {
      if (r.status === "rejected" || (r.status === "fulfilled" && !r.value)) {
        failures += 1;
      }
    }
    return failures;
  }

  private async _tryAnnounceTopic(topic: string): Promise<boolean> {
    try {
      const infoHash = topicToInfoHash(topic);
      await this.config.dht.announce(infoHash, this.config.signalingPort);
      this.config.healthMonitor?.recordAnnounce(true);
      return true;
    } catch (err) {
      this.config.healthMonitor?.recordAnnounce(false);
      debugWarn(`[Announcer] Announce failed for ${topic}: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  private _normalizeServiceCategories(
    serviceCategories: Record<string, string[]> | undefined,
    supportedServices: string[],
  ): Record<string, string[]> | undefined {
    if (!serviceCategories) {
      return undefined;
    }

    const hasWildcardServices = supportedServices.length === 0;
    const supportedServiceSet = new Set(supportedServices);
    const normalized: Record<string, string[]> = {};
    for (const [service, categories] of Object.entries(serviceCategories)) {
      if (!hasWildcardServices && !supportedServiceSet.has(service)) {
        continue;
      }
      const deduped = Array.from(
        new Set(
          categories
            .map((category) => category.trim().toLowerCase())
            .filter((category) => category.length > 0),
        ),
      );
      if (deduped.length === 0) {
        continue;
      }
      normalized[service] = deduped;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private _normalizeServiceApiProtocols(
    serviceApiProtocols: Record<string, ServiceApiProtocol[]> | undefined,
    supportedServices: string[],
  ): Record<string, ServiceApiProtocol[]> | undefined {
    if (!serviceApiProtocols) {
      return undefined;
    }

    const hasWildcardServices = supportedServices.length === 0;
    const supportedServiceSet = new Set(supportedServices);
    const normalized: Record<string, ServiceApiProtocol[]> = {};
    for (const [service, protocols] of Object.entries(serviceApiProtocols)) {
      if (!hasWildcardServices && !supportedServiceSet.has(service)) {
        continue;
      }
      const deduped = Array.from(
        new Set(
          protocols
            .map((protocol) => protocol.trim().toLowerCase())
            .filter((protocol): protocol is ServiceApiProtocol => isKnownServiceApiProtocol(protocol)),
        ),
      );
      if (deduped.length === 0) {
        continue;
      }
      normalized[service] = deduped;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private _normalizeServiceUnitBillingModels(
    serviceUnitBillingModels: ServiceUnitBillingModelsV1 | undefined,
    supportedServices: string[],
  ): ServiceUnitBillingModelsV1 | undefined {
    if (!serviceUnitBillingModels) {
      return undefined;
    }

    const hasWildcardServices = supportedServices.length === 0;
    const supportedServiceSet = new Set(supportedServices);
    const normalized: ServiceUnitBillingModelsV1 = {};
    for (const [service, protocolModels] of Object.entries(serviceUnitBillingModels)) {
      if (!hasWildcardServices && !supportedServiceSet.has(service)) {
        continue;
      }
      const entries = Object.entries(protocolModels)
        .filter(([protocol, model]) => isKnownServiceApiProtocol(protocol) && model?.version === 1 && Array.isArray(model.components));
      if (entries.length === 0) {
        continue;
      }
      normalized[service] = Object.fromEntries(entries) as ServiceUnitBillingModelsV1[string];
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private _normalizeServiceCapabilities(
    serviceCapabilities: Record<string, ServiceCapabilities> | undefined,
    supportedServices: string[],
  ): Record<string, ServiceCapabilities> | undefined {
    if (!serviceCapabilities) {
      return undefined;
    }

    const hasWildcardServices = supportedServices.length === 0;
    const supportedServiceSet = new Set(supportedServices);
    const normalized: Record<string, ServiceCapabilities> = {};
    for (const [service, caps] of Object.entries(serviceCapabilities)) {
      if (!hasWildcardServices && !supportedServiceSet.has(service)) {
        continue;
      }
      if (!caps || typeof caps !== "object" || Object.keys(caps).length === 0) {
        continue;
      }
      normalized[service] = caps;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }
}
