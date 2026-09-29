# antseed-e2e

[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Vitest](https://img.shields.io/badge/vitest-1.2+-yellow.svg)](https://vitest.dev/)

End-to-end tests for the Antseed Network. These tests exercise the full P2P inference flow: DHT discovery, peer connection, request proxying, and SSE streaming -- all running against a local bootstrap node with mock providers.

## Running Tests

```bash
npm test          # Single run
npm run test:watch  # Watch mode
```

## Local Blockchain Full Flow

Run a complete local payment + networking flow (no external API keys):

1. Start a local Anvil chain
2. Build and deploy `MockUSDC` + `AntseedIdentity` + `AntseedStaking` + `AntseedDeposits` + `AntseedChannels` with Foundry
3. Start isolated local DHT bootstrap + seller + buyer nodes
4. Mint/fund buyer + seller wallets
5. Buyer deposits into AntseedDeposits, sends a real P2P request, then triggers settlement
6. Verify on-chain settled state, balances, and reputation updates

```bash
npm run flow:local-chain
```

Prerequisites:
- Foundry installed and on `PATH` (`anvil`, `forge`, `cast`)
- Node.js >= 20

Optional environment overrides:
- `RPC_URL` (default: `http://127.0.0.1:8545`)
- `CHAIN_ID` (default: `31337`)
- `DEPLOYER_PRIVATE_KEY` (default: Anvil account #0 private key)
- `FLOW_FUND_ETH` (default: `2ether`)
- `ANVIL_HOST` / `ANVIL_PORT` (override host/port Anvil binds to; defaults derived from `RPC_URL`)

On success, the script prints a JSON summary with deployed contract addresses, peer IDs, session status, balances, and reputation.

## Test Suites

### Discovery (`tests/discovery.test.ts`)

Verifies that a seller node can announce itself on the DHT and a buyer node can discover it.

- Starts a local DHT bootstrap node
- Creates a seller with a mock Anthropic provider and starts it
- Creates a buyer, starts it, and calls `discoverPeers()`
- Asserts the seller's peer ID appears in the discovered peer list

### Request Flow (`tests/request-flow.test.ts`)

Verifies end-to-end request delivery and response over the P2P connection.

- **Single request**: buyer sends one `POST /v1/messages` request to the discovered seller and asserts a 200 response with the expected JSON body
- **Concurrent requests**: buyer sends 5 parallel requests and asserts all 5 return successfully with correct request IDs

### Streaming (`tests/streaming.test.ts`)

Verifies that Server-Sent Events (SSE) streaming responses survive the P2P transport.

- Uses a `StreamingMockProvider` that returns a full SSE event stream (`message_start`, `content_block_delta`, `message_stop`, etc.)
- Buyer sends a `stream: true` request and receives the response
- Asserts the response has `content-type: text/event-stream` and contains all expected SSE event types and text deltas

## Architecture

### Local DHT Bootstrap (`tests/helpers/local-bootstrap.ts`)

Each test suite creates an isolated DHT network by starting a `DHTNode` on an OS-assigned port with an empty bootstrap list. Seller and buyer nodes bootstrap against this local node, so tests are fully isolated from the production network.

```ts
const bootstrap = await createLocalBootstrap();
// bootstrap.bootstrapConfig = [{ host: '127.0.0.1', port: <ephemeral> }]
```

### Mock Provider (`tests/helpers/mock-provider.ts`)

`MockAnthropicProvider` implements the `Provider` interface and returns canned JSON responses without making any real API calls. It tracks `requestCount` for assertions.

All nodes use OS-assigned ports (`dhtPort: 0`, `signalingPort: 0`) and temporary data directories that are cleaned up in `afterEach`.

## Adding a New Test Scenario

1. Create a new file in `tests/` (e.g. `tests/my-scenario.test.ts`)
2. Use `createLocalBootstrap()` to set up an isolated DHT
3. Create seller and buyer `AntseedNode` instances with OS-assigned ports
4. Register a mock provider on the seller (or write a custom one)
5. Start both nodes, wait for DHT propagation (~3 seconds), then run assertions
6. Clean up in `afterEach`: stop buyer, seller, bootstrap, and remove temp dirs

```ts
import { createLocalBootstrap } from './helpers/local-bootstrap.js';
import { MockAnthropicProvider } from './helpers/mock-provider.js';
import { AntseedNode } from '@antseed/node';

// See existing tests for the full pattern
```

## Dependencies

This package depends on all three core Antseed packages:

- [`@antseed/node`](../@antseed/node) -- core protocol SDK
- [`antseed-provider-anthropic`](../antseed-provider-anthropic) -- Anthropic provider plugin
- [`antseed-router-claude-code`](../antseed-router-claude-code) -- Claude Code router plugin
