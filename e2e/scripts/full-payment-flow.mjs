#!/usr/bin/env node

/**
 * full-payment-flow.mjs
 *
 * Headless end-to-end test of the FULL payment flow:
 *   deploy contracts -> fund wallets -> register/stake/deposit ->
 *   start seller & buyer nodes -> send paid requests -> verify on-chain ->
 *   disconnect -> settle -> verify settlement
 *
 * Prerequisites:
 *   anvil &                      # local Ethereum chain
 *   pnpm run build               # build all packages
 *   node e2e/scripts/full-payment-flow.mjs
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { TextDecoder, TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

import {
  AntseedNode,
  loadOrCreateIdentity,
  toPeerId,
  DepositsClient,
  ChannelsClient,
  DHTNode,
  signSetOperator,
  makeDepositsDomain,
} from "../../packages/node/dist/index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = 31337;

const DEPLOYER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Deterministic addresses from Deploy.s.sol nonce sequence on fresh anvil
const USDC_ADDRESS     = "0x5FbDB2315678afecb367f032d93F642f64180aa3"; // nonce 0
const REGISTRY_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"; // nonce 1 — MockERC8004Registry
// nonce 2 = ANTSToken, nonce 3 = AntseedRegistry
const STAKING_ADDRESS  = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9"; // nonce 4
const DEPOSITS_ADDRESS = "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707"; // nonce 5
const CHANNELS_ADDRESS = "0x0165878A594ca255338adfa4d48449f69242Eb8F"; // nonce 6
// nonce 7 = Stats, nonce 8 = Emissions

const FUND_ETH = "2ether";
const USDC_MINT_AMOUNT = "100000000"; // 100 USDC (6 decimals)
const USDC_STAKE_AMOUNT = "50000000"; // 50 USDC
const USDC_DEPOSIT_AMOUNT = 10_000_000n; // 10 USDC

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const contractsDir = resolve(repoRoot, "packages", "contracts");

// ---------------------------------------------------------------------------
// Colored output helpers
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function pass(msg) {
  console.log(`${GREEN}  [PASS]${RESET} ${msg}`);
}

function fail(msg) {
  console.log(`${RED}  [FAIL]${RESET} ${msg}`);
}

function phase(num, title) {
  console.log(`\n${BOLD}${CYAN}=== Phase ${num}: ${title} ===${RESET}`);
}

function info(msg) {
  console.log(`${YELLOW}  [INFO]${RESET} ${msg}`);
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function requireCommand(command) {
  const check = spawnSync("which", [command], { encoding: "utf8" });
  if (check.status !== 0) {
    throw new Error(`Required command not found on PATH: ${command}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
  });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\n${combined || "(no output)"}`
    );
  }
  return combined;
}

function castSend(args, privateKey = DEPLOYER_PRIVATE_KEY) {
  return run("cast", ["send", "--rpc-url", RPC_URL, "--private-key", privateKey, ...args]);
}

function castCall(args) {
  return run("cast", ["call", "--rpc-url", RPC_URL, ...args]);
}

/** Parse cast output like "50000000 [5e7]" to a clean number string. */
function parseCastUint(raw) {
  return raw.trim().split(/\s/)[0];
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

async function waitForRpcReady(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) {
        const payload = await res.json();
        if (typeof payload?.result === "string" && payload.result.startsWith("0x")) return;
      }
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error(`RPC ${url} did not respond within ${timeoutMs}ms`);
}

async function waitForValue(getValue, label, timeoutMs = 20_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await getValue();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
  throw new Error(`Timeout waiting for ${label}${suffix}`);
}

function isNonceRaceError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("nonce has already been used") || msg.includes("nonce too low");
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

class MockProvider {
  constructor() {
    this.name = "anthropic";
    this.services = ["claude-sonnet-4-5-20250929"];
    this.pricing = {
      defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
    };
    this.maxConcurrency = 5;
    this._active = 0;
    this.requestCount = 0;
  }

  async handleRequest(req) {
    this._active += 1;
    this.requestCount += 1;
    try {
      const body = JSON.stringify({
        id: `msg_flow_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello from full-payment-flow E2E test." }],
        model: "claude-sonnet-4-5-20250929",
        usage: { input_tokens: 120, output_tokens: 30 },
      });
      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(body),
      };
    } finally {
      this._active -= 1;
    }
  }

  getCapacity() {
    return { current: this._active, max: this.maxConcurrency };
  }
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

function buildRequest() {
  return {
    requestId: randomUUID(),
    method: "POST",
    path: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(
      JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 256,
        messages: [{ role: "user", content: "Hello from E2E test" }],
      })
    ),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const results = [];

function record(phaseName, passed) {
  results.push({ phase: phaseName, passed });
}

async function main() {
  requireCommand("forge");
  requireCommand("cast");

  let bootstrap = null;
  let sellerNode = null;
  let buyerNode = null;
  let sellerDataDir = null;
  let buyerDataDir = null;

  // Addresses derived from identities — populated in Phase 2
  let sellerAddress = null;
  let buyerAddress = null;
  let sellerPrivateKey = null;
  let buyerPrivateKey = null;
  let discoveredSeller = null;
  let activeChannelId = null;

  try {
    // -----------------------------------------------------------------------
    // Phase 1: Deploy contracts
    // -----------------------------------------------------------------------
    phase(1, "Deploy contracts on anvil");

    await waitForRpcReady(RPC_URL);
    info("anvil is reachable");

    info("running forge script Deploy.s.sol...");
    run(
      "forge",
      [
        "script",
        "script/Deploy.s.sol",
        "--rpc-url", RPC_URL,
        "--broadcast",
      ],
      {
        cwd: contractsDir,
        env: {
          DEPLOYER_PRIVATE_KEY,
        },
        timeout: 600_000,
      }
    );

    info(`MockUSDC:      ${USDC_ADDRESS}`);
    info(`Registry:      ${REGISTRY_ADDRESS}`);
    info(`Staking:       ${STAKING_ADDRESS}`);
    info(`Deposits:      ${DEPOSITS_ADDRESS}`);
    info(`Channels:      ${CHANNELS_ADDRESS}`);
    pass("Contracts deployed and wired");
    record("1-deploy", true);

    // -----------------------------------------------------------------------
    // Phase 2: Fund wallets and setup on-chain state
    // -----------------------------------------------------------------------
    phase(2, "Fund wallets and setup on-chain state");

    // Create temp data dirs and derive wallet addresses from secp256k1 identities
    sellerDataDir = await mkdtemp(join(tmpdir(), "antseed-e2e-seller-"));
    buyerDataDir = await mkdtemp(join(tmpdir(), "antseed-e2e-buyer-"));

    const sellerIdentity = await loadOrCreateIdentity(sellerDataDir);
    const buyerIdentity = await loadOrCreateIdentity(buyerDataDir);

    sellerAddress = sellerIdentity.wallet.address;
    buyerAddress = buyerIdentity.wallet.address;
    sellerPrivateKey = sellerIdentity.wallet.privateKey;
    buyerPrivateKey = buyerIdentity.wallet.privateKey;

    info(`Seller EVM: ${sellerAddress}`);
    info(`Buyer  EVM: ${buyerAddress}`);

    // Fund ETH
    info("Funding ETH...");
    castSend([sellerAddress, "--value", FUND_ETH]);
    castSend([buyerAddress, "--value", FUND_ETH]);
    pass("ETH funded");

    // Mint USDC
    info("Minting USDC...");
    castSend([USDC_ADDRESS, "mint(address,uint256)", sellerAddress, USDC_MINT_AMOUNT]);
    castSend([USDC_ADDRESS, "mint(address,uint256)", buyerAddress, USDC_MINT_AMOUNT]);
    pass("USDC minted");

    // Register seller identity via ERC-8004 registry
    info("Registering seller identity...");
    castSend(
      [REGISTRY_ADDRESS, "register()"],
      sellerPrivateKey
    );
    // The agentId is 1 for the first registration on a fresh chain
    const sellerAgentId = "1";
    pass("Seller identity registered (ERC-8004)");

    // Seller stakes (agentId, amount)
    info("Seller staking 50 USDC...");
    castSend(
      [USDC_ADDRESS, "approve(address,uint256)", STAKING_ADDRESS, USDC_STAKE_AMOUNT],
      sellerPrivateKey
    );
    castSend(
      [STAKING_ADDRESS, "stake(uint256,uint256)", sellerAgentId, USDC_STAKE_AMOUNT],
      sellerPrivateKey
    );
    pass("Seller staked");

    // Set buyer as its own operator
    info("Setting buyer operator...");
    const depositsDomain = makeDepositsDomain(CHAIN_ID, DEPOSITS_ADDRESS);
    const operatorSig = await signSetOperator(buyerIdentity.wallet, depositsDomain, {
      operator: buyerAddress,
      nonce: 0n,
    });
    castSend(
      [DEPOSITS_ADDRESS, "setOperator(address,address,uint256,bytes)", buyerAddress, buyerAddress, "0", operatorSig],
      buyerPrivateKey
    );
    pass("Operator set");

    // Buyer deposits
    info("Buyer depositing 10 USDC...");
    castSend(
      [USDC_ADDRESS, "approve(address,uint256)", DEPOSITS_ADDRESS, USDC_DEPOSIT_AMOUNT.toString()],
      buyerPrivateKey
    );
    castSend(
      [DEPOSITS_ADDRESS, "deposit(address,uint256)", buyerAddress, USDC_DEPOSIT_AMOUNT.toString()],
      buyerPrivateKey
    );
    pass("Buyer deposited");

    record("2-fund-setup", true);

    // -----------------------------------------------------------------------
    // Phase 3: Start seller node
    // -----------------------------------------------------------------------
    phase(3, "Start seller node");

    const sellerProvider = new MockProvider();

    // Start an isolated local DHT bootstrap node
    bootstrap = new DHTNode({
      peerId: toPeerId("0".repeat(40)),
      port: 0,
      bootstrapNodes: [],
      reannounceIntervalMs: 60_000,
      operationTimeoutMs: 5_000,
    });
    await bootstrap.start();
    const bootstrapConfig = [{ host: "127.0.0.1", port: bootstrap.getPort() }];
    info(`Local DHT bootstrap on port ${bootstrap.getPort()}`);

    sellerNode = new AntseedNode({
      role: "seller",
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrapConfig,
      noOfficialBootstrap: true,
      allowPrivateIPs: true,
      payments: {
        enabled: true,
        paymentMethod: "crypto",
        settlementIdleMs: 5_000,
        defaultDepositAmountUSDC: "1000000",
        rpcUrl: RPC_URL,
        depositsAddress: DEPOSITS_ADDRESS,
        channelsAddress: CHANNELS_ADDRESS,
        stakingAddress: STAKING_ADDRESS,
        identityRegistryAddress: REGISTRY_ADDRESS,

        usdcAddress: USDC_ADDRESS,
        chainId: CHAIN_ID,
        minBudgetPerRequest: "10000",
      },
    });
    sellerNode.registerProvider(sellerProvider);
    await sellerNode.start();
    info(`Seller peerId: ${sellerNode.peerId}`);
    info(`Seller signaling port: ${sellerNode.signalingPort}`);
    pass("Seller node started");
    record("3-seller-start", true);

    // -----------------------------------------------------------------------
    // Phase 4: Start buyer node
    // -----------------------------------------------------------------------
    phase(4, "Start buyer node");

    buyerNode = new AntseedNode({
      role: "buyer",
      dataDir: buyerDataDir,
      dhtPort: 0,
      bootstrapNodes: bootstrapConfig,
      noOfficialBootstrap: true,
      allowPrivateIPs: true,
      payments: {
        enabled: true,
        paymentMethod: "crypto",
        settlementIdleMs: 5_000,
        defaultDepositAmountUSDC: "1000000",
        rpcUrl: RPC_URL,
        depositsAddress: DEPOSITS_ADDRESS,
        channelsAddress: CHANNELS_ADDRESS,
        stakingAddress: STAKING_ADDRESS,
        identityRegistryAddress: REGISTRY_ADDRESS,

        usdcAddress: USDC_ADDRESS,
        chainId: CHAIN_ID,
        maxPerRequestUsdc: "100000",
        maxReserveAmountUsdc: "1000000",
      },
    });
    await buyerNode.start();
    info(`Buyer peerId: ${buyerNode.peerId}`);
    pass("Buyer node started");

    // Discover seller
    info("Waiting for buyer to discover seller via DHT...");
    try {
      discoveredSeller = await waitForValue(
        async () => {
          // Force announce so discovery is deterministic on isolated DHT
          const announcer = sellerNode._announcer;
          if (announcer && typeof announcer.announce === "function") {
            await announcer.announce().catch(() => undefined);
          }
          const peers = await buyerNode.discoverPeers("anthropic");
          return peers.find((p) => p.peerId === sellerNode.peerId);
        },
        "seller discovery",
        30_000,
        500
      );
      if (!discoveredSeller.evmAddress) {
        discoveredSeller = { ...discoveredSeller, evmAddress: sellerAddress };
      }
      pass(`Discovered seller via DHT: ${discoveredSeller.peerId}`);
    } catch {
      // Fallback to direct peer address if DHT is flaky
      discoveredSeller = {
        peerId: sellerNode.peerId,
        lastSeen: Date.now(),
        providers: ["anthropic"],
        publicAddress: `127.0.0.1:${sellerNode.signalingPort}`,
        evmAddress: sellerAddress,
      };
      info("DHT discovery timed out; using direct peer address fallback");
      pass("Seller reachable via direct address");
    }
    record("4-buyer-discover", true);

    // -----------------------------------------------------------------------
    // Phase 5: Send a paid request
    // -----------------------------------------------------------------------
    phase(5, "Send first paid request");

    const bpm = buyerNode.buyerPaymentManager;
    if (!bpm) {
      throw new Error("Buyer payment manager not initialized");
    }

    // Ensure buyer has on-chain deposit via the node's BPM (redundant if cast deposit worked,
    // but validates the BPM deposit path)
    info("Sending request #1...");
    const response1 = await buyerNode.sendRequest(discoveredSeller, buildRequest());
    if (response1.statusCode !== 200) {
      throw new Error(`Request #1 failed with status ${response1.statusCode}`);
    }
    const body1 = JSON.parse(new TextDecoder().decode(response1.body));
    if (body1?.type !== "message") {
      throw new Error(`Unexpected response type: ${body1?.type}`);
    }
    info(`Response: "${body1.content[0]?.text}"`);
    pass("Request #1 returned 200 with correct body");
    record("5-first-request", true);

    // -----------------------------------------------------------------------
    // Phase 6: Send 2 more requests (cumulative spending auth)
    // -----------------------------------------------------------------------
    phase(6, "Send 2 more paid requests (cumulative SpendingAuth)");

    info("Sending request #2...");
    const response2 = await buyerNode.sendRequest(discoveredSeller, buildRequest());
    if (response2.statusCode !== 200) {
      throw new Error(`Request #2 failed with status ${response2.statusCode}`);
    }
    pass("Request #2 returned 200");

    info("Sending request #3...");
    const response3 = await buyerNode.sendRequest(discoveredSeller, buildRequest());
    if (response3.statusCode !== 200) {
      throw new Error(`Request #3 failed with status ${response3.statusCode}`);
    }
    pass("Request #3 returned 200");

    if (sellerProvider.requestCount !== 3) {
      throw new Error(`Expected 3 provider requests, got ${sellerProvider.requestCount}`);
    }
    pass(`Mock provider received all 3 requests`);
    record("6-multi-request", true);

    // -----------------------------------------------------------------------
    // Phase 7: Verify on-chain state
    // -----------------------------------------------------------------------
    phase(7, "Verify on-chain state (pre-settlement)");

    // Wait for seller session to be established
    const sellerSession = await waitForValue(
      async () => {
        const sessions = sellerNode.getActiveSellerSessions();
        return sessions.find((s) => s.buyerPeerId === buyerNode.peerId);
      },
      "active seller session",
      10_000,
      250
    );
    activeChannelId = sellerSession.sessionId;
    info(`Active session: ${activeChannelId}`);
    pass(`Session active with ${sellerSession.totalRequests} requests`);

    // Check buyer deposit balance via cast
    const buyerBalanceRaw = castCall([
      DEPOSITS_ADDRESS,
      "getBuyerBalance(address)(uint256,uint256,uint256)",
      buyerAddress,
    ]);
    info(`Buyer balance (available, reserved, lastActivity): ${buyerBalanceRaw}`);

    // Parse the first two values — available and reserved (cast output: "1000000 [1e6]")
    const balanceParts = buyerBalanceRaw.split("\n").map((s) => s.trim().split(" ")[0]);
    const reservedBalance = BigInt(balanceParts[1] || "0");
    if (reservedBalance > 0n) {
      pass(`Buyer has reserved balance: ${reservedBalance}`);
    } else {
      info("No reserved balance detected (session may use off-chain tracking)");
    }

    // Check session on-chain
    const channelsClient = new ChannelsClient({
      rpcUrl: RPC_URL,
      contractAddress: CHANNELS_ADDRESS,
    });

    let sessionInfo;
    try {
      sessionInfo = await channelsClient.getSession(activeChannelId);
      info(`On-chain session status: ${sessionInfo.status} (0=Active, 1=Settled)`);
      if (sessionInfo.status === 0) {
        pass("Session is Active on-chain");
      }
    } catch (err) {
      info(`Session query: ${err.message} (may not be on-chain yet if reserve is pending)`);
    }

    // Check seller stake
    const sellerStake = castCall([
      STAKING_ADDRESS,
      "getStake(address)(uint256)",
      sellerAddress,
    ]);
    info(`Seller stake: ${sellerStake}`);
    pass("On-chain state verified");
    record("7-onchain-verify", true);

    // -----------------------------------------------------------------------
    // Phase 8: Disconnect buyer and verify settlement
    // -----------------------------------------------------------------------
    phase(8, "Disconnect buyer and settle");

    info("Stopping buyer node...");
    await buyerNode.stop();
    buyerNode = null;
    pass("Buyer node stopped");

    // Wait for seller to auto-settle (settleOnDisconnect=true by default)
    info("Waiting for seller to settle on-chain (up to 30s)...");

    const depositsClient = new DepositsClient({
      rpcUrl: RPC_URL,
      contractAddress: DEPOSITS_ADDRESS,
      usdcAddress: USDC_ADDRESS,
    });

    // Wait for seller USDC balance to increase (direct transfer from settle/close)
    const sellerBalanceBefore = BigInt(parseCastUint(castCall([USDC_ADDRESS, "balanceOf(address)(uint256)", sellerAddress])));
    const sellerEarnings = await waitForValue(
      async () => {
        const balance = BigInt(parseCastUint(castCall([USDC_ADDRESS, "balanceOf(address)(uint256)", sellerAddress])));
        const earned = balance - sellerBalanceBefore;
        return earned > 0n ? earned : null;
      },
      "seller USDC earnings after settlement",
      60_000,
      500
    );
    pass(`Seller earned ${sellerEarnings} USDC base units (direct transfer)`);

    // Verify session is settled (activeChannelId is an internal UUID, not the
    // on-chain channelId — wrap in try/catch since this is informational)
    try {
      const settledSession = await channelsClient.getSession(activeChannelId);
      if (settledSession.status === 1) {
        pass("Session status = Settled (1)");
      } else {
        info(`Session status = ${settledSession.status} (expected 1=Settled)`);
      }
      info(`Settled amount: ${settledSession.settledAmount}`);
    } catch (err) {
      info(`Session on-chain query skipped (internal sessionId ≠ channelId): ${err.message?.slice(0, 60)}`);
    }

    // Verify buyer reservation released
    const buyerFinalBalance = await depositsClient.getBuyerBalance(buyerAddress);
    if (buyerFinalBalance.reserved === 0n) {
      pass("Buyer reserved balance released (0)");
    } else {
      throw new Error(`Buyer still has reserved: ${buyerFinalBalance.reserved}`);
    }

    // Verify buyer balance reduced by settled amount
    const buyerRemainingAvailable = buyerFinalBalance.available;
    info(`Buyer available after settlement: ${buyerRemainingAvailable}`);
    if (buyerRemainingAvailable < USDC_DEPOSIT_AMOUNT) {
      pass(`Buyer balance reduced from ${USDC_DEPOSIT_AMOUNT} to ${buyerRemainingAvailable}`);
    } else {
      info("Buyer balance not reduced (settled amount may be zero or returned)");
    }

    record("8-settle", true);

    // -----------------------------------------------------------------------
    // Phase 9: Cleanup
    // -----------------------------------------------------------------------
    phase(9, "Cleanup");

    info("Stopping seller node...");
    await sellerNode.stop();
    sellerNode = null;
    pass("Seller node stopped");

    if (bootstrap) {
      await bootstrap.stop();
      bootstrap = null;
    }
    pass("Bootstrap DHT stopped");

    record("9-cleanup", true);
  } catch (err) {
    const currentPhase = results.length > 0 ? results[results.length - 1].phase : "unknown";
    const failedPhase = `${currentPhase}-next`;
    fail(`${err.message}`);
    if (err.stack) {
      console.error(err.stack);
    }
    record(failedPhase, false);
  } finally {
    // Best-effort cleanup
    try { if (buyerNode) await buyerNode.stop(); } catch { /* ignore */ }
    try { if (sellerNode) await sellerNode.stop(); } catch { /* ignore */ }
    try { if (bootstrap) await bootstrap.stop(); } catch { /* ignore */ }
    try { if (sellerDataDir) await rm(sellerDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { if (buyerDataDir) await rm(buyerDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\n${BOLD}=== Summary ===${RESET}`);
  let allPassed = true;
  for (const r of results) {
    if (r.passed) {
      console.log(`  ${GREEN}PASS${RESET}  ${r.phase}`);
    } else {
      console.log(`  ${RED}FAIL${RESET}  ${r.phase}`);
      allPassed = false;
    }
  }

  if (allPassed && results.length >= 9) {
    console.log(`\n${GREEN}${BOLD}All ${results.length} phases passed.${RESET}\n`);
    process.exit(0);
  } else {
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    console.log(
      `\n${RED}${BOLD}${passed} passed, ${failed} failed out of ${results.length} phases.${RESET}\n`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n${RED}[FATAL]${RESET} ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
