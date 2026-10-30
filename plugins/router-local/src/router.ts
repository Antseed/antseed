import {
  detectRequestServiceApiProtocol,
  isNativeVideoProtocol,
  isProviderServiceRouteFailing,
  normalizedModelReputationScore,
  type Router,
  type PeerInfo,
  type SerializedHttpRequest,
  type ServiceApiProtocol,
} from '@antseed/node';
import {
  scoreCandidates,
  PeerMetricsTracker,
  type TokenPricingUsdPerMillion,
  type ScoringWeights,
} from '@antseed/router-core';

export interface BuyerMaxPricingConfig {
  defaults: TokenPricingUsdPerMillion;
  providers?: Record<string, {
    defaults?: TokenPricingUsdPerMillion;
    services?: Record<string, TokenPricingUsdPerMillion>;
  }>;
}

export interface LocalRouterConfig {
  minReputation?: number;
  maxPricing?: BuyerMaxPricingConfig;
  maxFailures?: number;
  failureCooldownMs?: number;
  maxPeerStalenessMs?: number;
  weights?: Partial<ScoringWeights>;
  now?: () => number;
}

export class LocalRouter implements Router {
  private readonly _minReputation: number;
  private readonly _maxPricing: BuyerMaxPricingConfig;
  private readonly _maxFailures: number;
  private readonly _maxPeerStalenessMs: number;
  private readonly _now: () => number;
  private readonly _weights: Partial<ScoringWeights> | undefined;
  private readonly _metrics: PeerMetricsTracker;

  constructor(config?: LocalRouterConfig) {
    this._minReputation = config?.minReputation ?? 0;
    this._maxPricing = {
      defaults: {
        inputUsdPerMillion: config?.maxPricing?.defaults.inputUsdPerMillion ?? Number.POSITIVE_INFINITY,
        outputUsdPerMillion: config?.maxPricing?.defaults.outputUsdPerMillion ?? Number.POSITIVE_INFINITY,
        ...(config?.maxPricing?.defaults.cachedInputUsdPerMillion != null
          ? { cachedInputUsdPerMillion: config.maxPricing.defaults.cachedInputUsdPerMillion }
          : {}),
      },
      ...(config?.maxPricing?.providers ? { providers: config.maxPricing.providers } : {}),
    };
    this._maxFailures = Math.max(1, config?.maxFailures ?? 3);
    this._maxPeerStalenessMs = Math.max(1, config?.maxPeerStalenessMs ?? 300_000);
    this._now = config?.now ?? (() => Date.now());
    this._weights = config?.weights;
    this._metrics = new PeerMetricsTracker({
      maxFailures: this._maxFailures,
      failureCooldownMs: Math.max(1, config?.failureCooldownMs ?? 30_000),
      now: this._now,
    });
  }

  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
    const now = this._now();
    const requestedService = this._extractRequestedService(req);
    // A native video request reaches only upstreams serving its protocol, so that route's health counts.
    const requestProtocol = detectRequestServiceApiProtocol(req);
    const routeProtocol = requestProtocol && isNativeVideoProtocol(requestProtocol) ? requestProtocol : undefined;

    const candidates: {
      peer: PeerInfo;
      provider: string;
      offer: TokenPricingUsdPerMillion;
    }[] = [];

    for (const peer of peers) {
      // Reputation filter
      if (this._effectiveReputation(peer) < this._minReputation) {
        continue;
      }

      // Cooldown filter
      if (this._metrics.isCoolingDown(peer.peerId)) {
        continue;
      }

      // Provider availability filter (automatic selection skips failing services)
      const provider = this._selectProviderForPeer(peer, requestedService, { protocol: routeProtocol });
      if (!provider) {
        continue;
      }

      // Pricing filter
      const offer = this._resolvePeerOfferPrice(peer, provider, requestedService);
      if (!offer) {
        continue;
      }

      const max = this._resolveBuyerMaxPrice(provider, requestedService);
      if (this._maxPriceRejection(offer, max) !== null) {
        continue;
      }

      candidates.push({ peer, provider, offer });
    }

    if (candidates.length === 0) return null;

    if (candidates.length === 1) {
      return candidates[0]!.peer;
    }

    // Delegate scoring to router-core
    const scoringInput = candidates.map((c) => ({
      peer: c.peer,
      provider: c.provider,
      providerRank: 0,
      offer: c.offer,
      metrics: this._metrics.getMetrics(c.peer.peerId),
    }));

    const scored = scoreCandidates(scoringInput, {
      now,
      medianLatency: this._metrics.getMedianLatency(),
      maxPeerStalenessMs: this._maxPeerStalenessMs,
      maxFailures: this._maxFailures,
      weights: this._weights,
    });

    return scored[0]?.peer ?? null;
  }

  onResult(
    peer: PeerInfo,
    result: { success: boolean; latencyMs: number; tokens: number },
  ): void {
    this._metrics.recordResult(peer.peerId, {
      success: result.success,
      latencyMs: result.latencyMs,
    });
  }

  allowsPeerForPricing(req: SerializedHttpRequest, peer: PeerInfo): boolean {
    return this._pricingRejection(req, peer) === null;
  }

  allowsPeerForPolicy(req: SerializedHttpRequest, peer: PeerInfo): boolean {
    return this.explainPolicyRejection(req, peer) === null;
  }

  /**
   * Human-readable reason `allowsPeerForPolicy` rejects this peer, or null
   * when it is allowed. Used by route previews.
   */
  explainPolicyRejection(req: SerializedHttpRequest, peer: PeerInfo): string | null {
    const reputation = this._effectiveReputation(peer);
    if (reputation < this._minReputation) {
      return `reputation ${Math.round(reputation)} below buyer minimum ${this._minReputation}`;
    }
    return this._pricingRejection(req, peer);
  }

  /** Why `allowsPeerForPricing` rejects this peer, or null when it is allowed. */
  private _pricingRejection(req: SerializedHttpRequest, peer: PeerInfo): string | null {
    const requestedService = this._extractRequestedService(req);
    const provider = this._selectProviderForPeer(peer, requestedService);
    if (!provider) return 'no provider for this model';
    const offer = this._resolvePeerOfferPrice(peer, provider, requestedService);
    if (!offer) return 'no valid price advertised';
    return this._maxPriceRejection(offer, this._resolveBuyerMaxPrice(provider, requestedService));
  }

  private _effectiveReputation(p: PeerInfo): number {
    return normalizedModelReputationScore(p) ?? 0;
  }

  private _extractRequestedService(req: SerializedHttpRequest): string | null {
    const contentType = req.headers['content-type'] ?? req.headers['Content-Type'] ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return null;
    }

    try {
      const parsed = JSON.parse(new TextDecoder().decode(req.body)) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      const service = (parsed as Record<string, unknown>)['model'];
      return typeof service === 'string' && service.trim().length > 0 ? service.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * The provider to price and send `requestedService` through. A healthy one
   * is preferred; only automatic selection (`automatic`) drops a service the
   * seller's own health check reports failing on every provider, or over the
   * request's protocol, so pricing and policy checks still allow a pinned
   * request to reach it.
   */
  private _selectProviderForPeer(
    peer: PeerInfo,
    requestedService: string | null,
    automatic?: { protocol?: ServiceApiProtocol },
  ): string | null {
    const availableProviders = peer.providers
      .map((provider) => provider.trim())
      .filter((provider) => provider.length > 0);

    // The seller's own health check says this provider cannot serve it right now.
    const isFailing = (provider: string): boolean => requestedService !== null
      && isProviderServiceRouteFailing(peer.providerServiceHealth, provider, requestedService, automatic?.protocol);
    // Providers pricing the service itself come first; any provider can still serve it at its default price.
    const pricingService = requestedService
      ? availableProviders.filter((provider) => peer.providerPricing?.[provider]?.services?.[requestedService])
      : [];
    const candidates = pricingService.length > 0 ? pricingService : availableProviders;
    const healthy = candidates.find((provider) => !isFailing(provider));
    if (healthy) return healthy;
    return automatic ? null : candidates[0] ?? null;
  }

  private _resolvePeerOfferPrice(
    peer: PeerInfo,
    provider: string,
    service: string | null,
  ): TokenPricingUsdPerMillion | null {
    const providerPricing = peer.providerPricing?.[provider];

    if (service) {
      const serviceSpecific = providerPricing?.services?.[service];
      if (serviceSpecific) {
        return this._isValidOffer(serviceSpecific) ? serviceSpecific : null;
      }
    }

    const providerDefaults = providerPricing?.defaults;
    if (providerDefaults) {
      return this._isValidOffer(providerDefaults) ? providerDefaults : null;
    }

    if (
      this._isFiniteNonNegative(peer.defaultInputUsdPerMillion) &&
      this._isFiniteNonNegative(peer.defaultOutputUsdPerMillion)
    ) {
      return {
        inputUsdPerMillion: peer.defaultInputUsdPerMillion,
        outputUsdPerMillion: peer.defaultOutputUsdPerMillion,
        ...(this._isFiniteNonNegative(peer.defaultCachedInputUsdPerMillion)
          ? { cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion }
          : {}),
      };
    }

    return null;
  }

  private _resolveBuyerMaxPrice(provider: string, service: string | null): TokenPricingUsdPerMillion {
    const providerPricing = this._maxPricing.providers?.[provider];

    if (service) {
      const serviceOverride = providerPricing?.services?.[service];
      if (serviceOverride && this._isValidBuyerMaxPrice(serviceOverride)) {
        return serviceOverride;
      }
    }

    const providerDefaults = providerPricing?.defaults;
    if (providerDefaults && this._isValidBuyerMaxPrice(providerDefaults)) {
      return providerDefaults;
    }

    return this._maxPricing.defaults;
  }

  private _isFiniteNonNegative(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  private _isValidOffer(offer: TokenPricingUsdPerMillion): boolean {
    return (
      this._isValidBuyerMaxPrice(offer) &&
      (
        offer.cachedInputUsdPerMillion === undefined ||
        offer.cachedInputUsdPerMillion <= offer.inputUsdPerMillion
      )
    );
  }

  private _isValidBuyerMaxPrice(pricing: TokenPricingUsdPerMillion): boolean {
    return (
      this._isFiniteNonNegative(pricing.inputUsdPerMillion) &&
      this._isFiniteNonNegative(pricing.outputUsdPerMillion) &&
      (
        pricing.cachedInputUsdPerMillion === undefined ||
        this._isFiniteNonNegative(pricing.cachedInputUsdPerMillion)
      )
    );
  }

  /** Which of the offer's prices exceeds the buyer's cap, or null when none does. */
  private _maxPriceRejection(offer: TokenPricingUsdPerMillion, max: TokenPricingUsdPerMillion): string | null {
    const maxCachedInput = max.cachedInputUsdPerMillion ?? max.inputUsdPerMillion;
    if (offer.inputUsdPerMillion > max.inputUsdPerMillion) {
      return `input price ${formatUsd(offer.inputUsdPerMillion)} over buyer cap ${formatUsd(max.inputUsdPerMillion)}`;
    }
    if (offer.outputUsdPerMillion > max.outputUsdPerMillion) {
      return `output price ${formatUsd(offer.outputUsdPerMillion)} over buyer cap ${formatUsd(max.outputUsdPerMillion)}`;
    }
    if (offer.cachedInputUsdPerMillion != null && offer.cachedInputUsdPerMillion > maxCachedInput) {
      return `cached input price ${formatUsd(offer.cachedInputUsdPerMillion)} over buyer cap ${formatUsd(maxCachedInput)}`;
    }
    return null;
  }
}

/** Up to 4 decimals; a sub-cent price keeps two significant digits so it never reads $0. */
function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toLocaleString('en-US', { maximumSignificantDigits: 2 })}`;
  return `$${Math.round(value * 10_000) / 10_000}`;
}
