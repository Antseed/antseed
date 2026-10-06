# @antseed/node

[![npm version](https://img.shields.io/npm/v/@antseed/node.svg)](https://www.npmjs.com/package/@antseed/node)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)

Core protocol SDK for AntSeed — a peer-to-peer AI services network. Providers offer AI services, buyers discover providers via DHT and send requests over encrypted P2P connections.

> **Important:** AntSeed is designed for providers who build differentiated services on top of AI APIs — such as TEE-secured inference, domain-specific skills and agents, fine-tuned models, or managed product experiences. Simply reselling raw API access or subscription credentials is not the intended use and may violate your upstream provider's terms of service.

## Installation

```bash
npm install @antseed/node
```

## Quick Start

### Provider Mode

A provider node announces its capacity on the DHT and serves inference requests from buyers.

```ts
import { AntseedNode } from '@antseed/node';
import type { Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';

// Implement the Provider interface (or use an existing plugin)
const myProvider: Provider = {
  name: 'my-llm',
  services: ['my-model-v1'],
  pricing: {
    defaults: {
      inputUsdPerMillion: 10,
      cachedInputUsdPerMillion: 1,  // optional, defaults to inputUsdPerMillion
      outputUsdPerMillion: 10,
    },
  },
  serviceCategories: {
    'my-model-v1': ['coding', 'privacy'],
  },
  maxConcurrency: 10,
  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    // Forward the request to your LLM backend and return the response
    const result = await callMyBackend(req);
    return {
      requestId: req.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(result)),
    };
  },
  getCapacity() {
    return { current: 0, max: 10 };
  },
};

const node = new AntseedNode({ role: 'seller' });
node.registerProvider(myProvider);
await node.start();

console.log('Seller peer ID:', node.peerId);
// Node is now discoverable on the DHT and accepting P2P connections
```

### Buyer Mode

A buyer node discovers sellers via DHT, connects to them, and sends inference requests.

```ts
import { AntseedNode } from '@antseed/node';
import { randomUUID } from 'node:crypto';

const node = new AntseedNode({ role: 'buyer' });
await node.start();

// Discover sellers on the network
const peers = await node.discoverPeers();

if (peers.length > 0) {
  const seller = peers[0];

  const response = await node.sendRequest(seller, {
    requestId: randomUUID(),
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Hello' }],
    })),
  });

  console.log('Response status:', response.statusCode);
}
```

## Discovery Topic Normalization

Discovery topics are normalized to improve lookup consistency:

- Provider topic: `antseed:{provider}` with `trim + lowercase`
- Model topic (canonical): `antseed:service:{model}` with `trim + lowercase`
- Model topic (search fallback): `antseed:service-search:{model}` with spaces, `-`, `_` removed after canonical normalization (keeps `.`)

Canonical and search model topics are both used when their keys differ, so variants like `kimi 2.5`, `kimi-2.5`, and `kimi_2.5` can converge in discovery while keeping exact canonical topics.

## Security Overview

For a full buyer-seller threat model and hardening guide, see:

- [`docs/protocol/spec/06-security-overview.md`](../../docs/protocol/spec/06-security-overview.md)

At a high level, `@antseed/node` currently enforces:

- Signed discovery metadata verification and staleness checks
- Signed connection intro envelopes with replay protection
- Frame, stream, and upload limits to reduce DoS exposure
- Payment-aware request gating (`402` if no session is reserved when payments are enabled)
- Signed bilateral receipts (secp256k1) plus on-chain payment authorization (ECDSA)

## Node Configuration

```ts
interface NodeConfig {
  role: 'seller' | 'buyer';
  displayName?: string;       // Optional human-readable name announced in metadata
  publicAddress?: string;     // Optional public host:port override announced in metadata
  dataDir?: string;           // Default: ~/.antseed
  identityStore?: IdentityStore; // Pluggable identity storage backend
  dhtPort?: number;           // Default: 6881 for seller, 0 (OS-assigned) for buyer
  signalingPort?: number;     // Default: 6882 for seller
  maxUploadBodyBytes?: number; // Default: 64 MiB per request
  bootstrapNodes?: Array<{ host: string; port: number }>;
  payments?: {
    enabled?: boolean;
    paymentMethod?: 'crypto';
    platformFeeRate?: number;
    settlementIdleMs?: number;
    defaultSessionAmountUSDC?: string;
    sellerWalletAddress?: string;
    paymentConfig?: PaymentConfig | null;
  };
}
```

| Option | Default | Description |
|---|---|---|
| `role` | (required) | `'seller'` to serve requests, `'buyer'` to consume them |
| `displayName` | unset | Optional node label included in discovery metadata |
| `publicAddress` | unset | Optional public `host:port` advertised in signed metadata and preferred by buyers over the raw DHT source address |
| `dataDir` | `~/.antseed` | Directory for identity keys, metering DB, and config |
| `identityStore` | `FileIdentityStore` | Pluggable identity storage backend (see [Identity Storage](#identity-storage)) |
| `dhtPort` | `6881` / `0` | UDP port for DHT. Seller defaults to 6881, buyer uses OS-assigned |
| `signalingPort` | `6882` | TCP port for P2P signaling and incoming connections (seller only) |
| `maxUploadBodyBytes` | `64 MiB` | Maximum request body a seller accepts per proxied upload. Raise this for large Codex-style `/v1/responses` payloads while keeping the aggregate pending-upload budget bounded. |
| `bootstrapNodes` | AntSeed nodes | Additional DHT bootstrap nodes merged with the official AntSeed infrastructure |
| `payments` | disabled | Optional seller-side payment channel + settlement lifecycle wiring |

Use `publicAddress` when the DHT announce source IP is not the address buyers should dial, such as Kubernetes or other load-balanced deployments:

```ts
const node = new AntseedNode({
  role: 'seller',
  publicAddress: 'peer.example.com:6882',
});
```

## Identity Storage

Every node has a secp256k1 identity keypair. The private key (32 bytes, stored as 64 hex characters) serves two roles:

1. **P2P identity** — signs metadata, connection handshakes, and metering receipts. Your PeerId is the EVM address (40 hex characters) derived from the public key.
2. **On-chain wallet** — the same secp256k1 key is used as the EVM wallet. This wallet holds deposits, stakes, receives seller earnings, and signs payment authorizations.

> **Important:** Losing your identity key means losing both your peer identity and access to any on-chain funds tied to the derived wallet.

### Storage Backends

Identity loading follows this priority:

1. **Environment variable (recommended for CLI/server)** — if `ANTSEED_IDENTITY_HEX` is set (64 hex chars, optional `0x` prefix), it is used directly and cleared from the environment immediately after read. Use this with secrets managers for production deployments.
2. **Desktop keychain (recommended for Desktop)** — AntSeed Desktop encrypts the key at rest via Electron `safeStorage` and the OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret).
3. **Custom IdentityStore** — if `identityStore` is passed in `NodeConfig`, it is used to load/save the key (e.g., KMS, HSM).
4. **Plaintext file (not recommended)** — reads/writes `identity.key` in `dataDir` (`~/.antseed/` by default) with `0600` permissions. Since this key is also your on-chain wallet, avoid storing it unencrypted on disk in production.

If no identity is found, a new keypair is generated and persisted via the active store.

### File Store (Default)

```ts
import { AntseedNode, FileIdentityStore } from '@antseed/node';

const node = new AntseedNode({
  role: 'seller',
  // These are equivalent — FileIdentityStore is the default:
  identityStore: new FileIdentityStore('/path/to/config-dir'),
  // dataDir: '/path/to/config-dir',
});
```

### Environment Variable

Pass the private key hex from a secrets manager (AWS SSM, HashiCorp Vault, etc.):

```bash
export ANTSEED_IDENTITY_HEX="$(vault kv get -field=key secret/antseed/identity)"
antseed seller start
```

The variable is cleared from the process environment immediately after consumption.

### Custom Store

Implement the `IdentityStore` interface for any backend:

```ts
import { AntseedNode, type IdentityStore } from '@antseed/node';

class VaultIdentityStore implements IdentityStore {
  async load(): Promise<string | null> {
    // Read 64-char hex string from your backend
    return await vault.getSecret('antseed-identity');
  }
  async save(hexKey: string): Promise<void> {
    // Persist the 64-char hex string
    await vault.putSecret('antseed-identity', hexKey);
  }
}

const node = new AntseedNode({
  role: 'seller',
  identityStore: new VaultIdentityStore(),
});
```

### Desktop App

The AntSeed Desktop app encrypts the identity at rest using Electron's `safeStorage` API. The encryption key is stored in the OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret) and the encrypted blob is stored at `~/.antseed/identity.enc`. On first launch, any existing plaintext `identity.key` is migrated to the encrypted store and deleted.

## On-Chain Settlement Flow

When `payments.enabled=true` in seller mode:

1. A per-buyer payment session is created via `BuyerPaymentManager`.
2. Deposit balance is locked on-chain at session start.
3. Usage receipts are generated during request handling.
4. On idle/session finalization, `calculateSettlement` computes cost from receipts and settles on-chain via:
   - `ChannelsClient.settle(sessionId, tokenCount)`
5. Any unused reservation is refunded to the buyer by contract logic in the same settlement transaction.

Minimal crypto config:

```ts
const node = new AntseedNode({
  role: 'seller',
  payments: {
    enabled: true,
    paymentMethod: 'crypto',
    platformFeeRate: 0.05,
    defaultSessionAmountUSDC: '1',
    sellerWalletAddress: '0xSeller...',
    paymentConfig: {
      crypto: {
        chainId: 'base',
        rpcUrl: process.env.RPC_URL!,
        depositsContractAddress: process.env.DEPOSITS_ADDRESS!,
        channelsContractAddress: process.env.CHANNELS_ADDRESS!,
        usdcContractAddress: process.env.USDC_ADDRESS!,
        autoFundDeposit: true,
      },
    },
  },
});
```

Smart contract source and deployment notes: `node/contracts/README.md`.

## Key Exports

### Recognized-usage payment helpers

Import these APIs from `@antseed/node/payments`:

- `SellerRegistryClient.getRegisteredAgentId(seller)` returns the explicitly
  bound identity, or `0` when only a legacy fallback exists.
  `registerSellerBinding(signer, agentId, onConfirmed?)` binds and verifies it,
  returning `false` without a transaction when already bound. The optional
  callback receives the confirmed hash before verification; verification
  failure throws `SellerRegistrationVerificationError`.
- `SellerPoolsClient.allStakerPositionIds(seller)` paginates active positions;
  `rewardPositions(seller)` also discovers withdrawn positions from burn logs.
  Historical discovery needs an RPC with historical code and log access.
  `earlyExitSlashBps(id)` and `estimateEarlyExit(position, slashBps)` provide
  an estimate, not a guaranteed maximum loss at transaction execution.
- `SellerPoolsRewardsClient.previewStakerRewards(positionIds)` returns ANTS
  base-unit amounts in input order, including unindexed completed epochs.
  Every call uses its own single-block snapshot and read cache; reuse of a
  client does not preserve stale previews. `previewStakerReward(id)` is the
  single-position equivalent. Neither method sends transactions.
- `previewPoolRewards`, `pendingEpochRewards`, `claimPoolRewards`,
  `claimEpochRewards`, and `claimBuyerEpochRewards` provide shared discovery,
  previews, and bounded claim orchestration. Pool claims index missing epochs
  before claiming. Callbacks expose confirmed transactions without CLI output.
- `ANTSTokenClient.receivedInTransaction(hash, recipient)` sums incoming ANTS
  transfers from a successful transaction receipt, rather than using estimates
  as the claimed total.

### Core API

```ts
// Main class
import { AntseedNode, type NodeConfig } from '@antseed/node';

// Interfaces
import type { Provider } from '@antseed/node';
import type { Router } from '@antseed/node';
import type {
  AntseedPlugin,
  AntseedProviderPlugin,
  AntseedRouterPlugin,
  ConfigField,
} from '@antseed/node';

// Identity & P2P
import { loadOrCreateIdentity, type Identity, type IdentityStore, FileIdentityStore } from '@antseed/node';
import { NatTraversal, type NatMapping, type NatTraversalResult } from '@antseed/node';

// Discovery
import { DHTNode, DEFAULT_DHT_CONFIG } from '@antseed/node';
import { OFFICIAL_BOOTSTRAP_NODES, mergeBootstrapNodes, toBootstrapConfig } from '@antseed/node';
import { MetadataServer, type MetadataServerConfig } from '@antseed/node';
import type { PeerMetadata, ProviderAnnouncement } from '@antseed/node';

// Metering & Payments
import { MeteringStorage } from '@antseed/node';
import { BalanceManager } from '@antseed/node';
import { BuyerPaymentManager, calculateSettlement } from '@antseed/node/payments';
import { BaseChannelsClient } from '@antseed/node';

// Routing & Proxy
import { ProxyMux } from '@antseed/node';
import { DefaultRouter, type DefaultRouterConfig } from '@antseed/node';
import { resolveProvider } from '@antseed/node';
// Plugin system
import { loadPluginModule, loadAllPlugins } from '@antseed/node';
import type { ConfigField } from '@antseed/node';
```

Submodule imports are also available:

```ts
import { DHTNode } from '@antseed/node/discovery';
import { MeteringStorage } from '@antseed/node/metering';
import { BalanceManager } from '@antseed/node/payments';
```

## Provider Interface

Implement `Provider` to expose any LLM backend as a provider on the network.

```ts
interface Provider {
  /** Unique name for this provider (e.g., 'anthropic', 'openai') */
  name: string;

  /** Model IDs this provider supports */
  services: string[];

  /** Pricing in USD per 1M tokens (defaults + optional per-service overrides) */
  pricing: {
    defaults: { inputUsdPerMillion: number; cachedInputUsdPerMillion?: number; outputUsdPerMillion: number };
    services?: Record<string, { inputUsdPerMillion: number; cachedInputUsdPerMillion?: number; outputUsdPerMillion: number }>;
  };

  /** Optional per-service discovery tags (e.g., coding/privacy/legal) */
  serviceCategories?: Record<string, string[]>;

  /** Optional per-service API protocol support advertised via discovery metadata. */
  serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;

  /** Maximum concurrent requests this provider can handle */
  maxConcurrency: number;

  /** Handle an incoming inference request and return the response */
  handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse>;

  /** Return current and maximum concurrent request counts */
  getCapacity(): { current: number; max: number };

  /** Optional startup hook (credential validation, warm-up, etc.) */
  init?(): Promise<void>;

  /** Optional capabilities beyond plain inference */
  capabilities?: ProviderCapability[];

}
```

## Router Interface

Implement `Router` to control how a buyer selects which seller to route each request to.

```ts
interface Router {
  /** Pick the best peer for a given request from the available peers. Return null to reject. */
  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null;

  /** Called after each request completes so the router can update internal state. */
  onResult(peer: PeerInfo, result: {
    success: boolean;
    latencyMs: number;
    tokens: number;
  }): void;
}
```

If no router is set, the SDK uses a built-in `DefaultRouter` that selects the cheapest peer above a minimum reputation threshold. The CLI buyer proxy adds a model-specific planning layer before dispatch: bare model ids are canonicalized and ranked with `@antseed/node/model-routing` using shared Price + Trust preferences, health signals, and seller access rules. Explicit peer pins bypass automatic peer selection.

## Building a Custom Provider Plugin

A provider plugin wraps a `Provider` so it can be installed and configured through the CLI.

```ts
import type { AntseedProviderPlugin, Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';

class MyProvider implements Provider {
  readonly name = 'my-provider';
  readonly services: string[];
  readonly pricing: Provider['pricing'];
  readonly maxConcurrency: number;
  private _active = 0;

  constructor(apiKey: string, services: string[], inputUsdPerMillion: number, outputUsdPerMillion: number, maxConcurrency: number) {
    this.services = services;
    this.pricing = {
      defaults: {
        inputUsdPerMillion,
        cachedInputUsdPerMillion: inputUsdPerMillion * 0.1, // optional, defaults to inputUsdPerMillion
        outputUsdPerMillion,
      },
    };
    this.maxConcurrency = maxConcurrency;
  }

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    this._active++;
    try {
      // Forward req to your upstream LLM and return the response
      const upstream = await fetch('https://my-llm.example.com/v1/chat', {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      return {
        requestId: req.requestId,
        statusCode: upstream.status,
        headers: Object.fromEntries(upstream.headers.entries()),
        body: new Uint8Array(await upstream.arrayBuffer()),
      };
    } finally {
      this._active--;
    }
  }

  getCapacity() {
    return { current: this._active, max: this.maxConcurrency };
  }
}

const plugin: AntseedProviderPlugin = {
  name: 'my-provider',
  displayName: 'My Provider',
  version: '1.0.0',
  type: 'provider',
  description: 'Provides My LLM capacity on the Antseed Network',
  configSchema: [
    { key: 'MY_API_KEY', label: 'API Key', type: 'secret', required: true, description: 'API key for My LLM' },
    { key: 'MY_SERVICES', label: 'Services', type: 'string[]', required: false, description: 'Comma-separated service list' },
    { key: 'MY_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, description: 'Input price in USD per 1M tokens' },
    { key: 'MY_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, description: 'Output price in USD per 1M tokens' },
  ],
  createProvider(config: Record<string, string>) {
    const apiKey = config['MY_API_KEY'] ?? '';
    const services = (config['MY_SERVICES'] ?? 'default-service').split(',').map(s => s.trim());
    const input = parseFloat(config['MY_INPUT_USD_PER_MILLION'] ?? '10');
    const output = parseFloat(config['MY_OUTPUT_USD_PER_MILLION'] ?? String(input));
    return new MyProvider(apiKey, services, input, output, 10);
  },
};

export default plugin;
```

## Building a Custom Router Plugin

A router plugin wraps a `Router` for CLI-based installation and configuration.

```ts
import type { AntseedRouterPlugin, Router, PeerInfo, SerializedHttpRequest } from '@antseed/node';

class CheapestRouter implements Router {
  private readonly _maxInputUsdPerMillion: number;

  constructor(maxInputUsdPerMillion: number) {
    this._maxInputUsdPerMillion = maxInputUsdPerMillion;
  }

  selectPeer(_req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
    const eligible = peers
      .filter(p => (p.defaultInputUsdPerMillion ?? Infinity) <= this._maxInputUsdPerMillion)
      .sort((a, b) => (a.defaultInputUsdPerMillion ?? 0) - (b.defaultInputUsdPerMillion ?? 0));
    return eligible[0] ?? null;
  }

  onResult(_peer: PeerInfo, _result: { success: boolean; latencyMs: number; tokens: number }): void {
    // Track metrics, update reputation, etc.
  }
}

const plugin: AntseedRouterPlugin = {
  name: 'cheapest',
  displayName: 'Cheapest Router',
  version: '1.0.0',
  type: 'router',
  description: 'Always routes to the cheapest available peer',
  configSchema: [
    { key: 'MAX_INPUT_USD_PER_MILLION', label: 'Max Input Price', type: 'number', required: false, description: 'Maximum input price in USD per 1M tokens' },
  ],
  createRouter(config: Record<string, string>) {
    const maxInput = parseFloat(config['MAX_INPUT_USD_PER_MILLION'] ?? 'Infinity');
    return new CheapestRouter(maxInput);
  },
};

export default plugin;
```

## Plugin Ecosystem

The Antseed plugin system uses a simple contract:

1. **Provider plugins** (`AntseedProviderPlugin`) export a default object with `type: 'provider'` and a `createProvider(config)` factory.
2. **Router plugins** (`AntseedRouterPlugin`) export a default object with `type: 'router'` and a `createRouter(config)` factory.
3. Both plugin types declare their configuration via `configSchema`, an array of `ConfigField` objects:

```ts
interface ConfigField {
  key: string;          // Environment variable name
  label: string;        // Human-readable label
  type: 'string' | 'number' | 'boolean' | 'secret' | 'string[]';
  required?: boolean;   // Whether the key must be set
  default?: unknown;    // Default value
  description?: string; // Description shown in CLI
}
```

The CLI reads these keys from environment variables and passes them as a `Record<string, string>` to the factory function. Plugins are installed with `antseed plugin add <package-name>`.

## Links

- [npm](https://www.npmjs.com/package/@antseed/node)
- [GitHub](https://github.com/AntSeed/node)
