#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { TextDecoder, TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

import { AntseedNode, toPeerId } from "@antseed/node";
import { DepositsClient, ChannelsClient } from "@antseed/node/payments";
import { DHTNode } from "@antseed/node/discovery";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const CHAIN_ID = process.env.CHAIN_ID ?? "31337";
const rpcEndpoint = new URL(RPC_URL);
const ANVIL_HOST = process.env.ANVIL_HOST ?? rpcEndpoint.hostname;
const ANVIL_PORT = process.env.ANVIL_PORT ?? (rpcEndpoint.port || "8545");

// Default Anvil account #0 private key
const DEPLOYER_PRIVATE_KEY =
  process.env.DEPLOYER_PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const USDC_MINT_AMOUNT = 25_000_000n; // 25 USDC
const USDC_DEPOSIT_AMOUNT = 5_000_000n; // 5 USDC
const FUND_ETH = process.env.FLOW_FUND_ETH ?? "2ether";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const contractsDir = resolve(repoRoot, "packages", "contracts");

function logStep(message) {
  console.log(`\n[flow] ${message}`);
}

function requireCommand(command) {
  const check = spawnSync("which", [command], { encoding: "utf8" });
  if (check.status !== 0) {
    throw new Error(`Required command not found on PATH: ${command}`);
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
  });

  const combinedOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\n` +
        (combinedOutput.length > 0 ? combinedOutput : "(no output)")
    );
  }
  return combinedOutput;
}

function castSend(args) {
  return runCommand("cast", [
    "send",
    "--rpc-url",
    RPC_URL,
    "--private-key",
    DEPLOYER_PRIVATE_KEY,
    ...args,
  ]);
}

function formatError(err) {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

function parseDeployedAddress(output) {
  const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/);
  if (!match) {
    throw new Error(`Could not parse deployment address from output:\n${output}`);
  }
  return match[1];
}

function isNonceRaceError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("nonce has already been used") ||
    message.includes("nonce too low") ||
    message.includes("NONCE_EXPIRED")
  );
}

async function waitForRpcReady(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      if (response.ok) {
        const payload = await response.json();
        if (typeof payload?.result === "string" && payload.result.startsWith("0x")) {
          return;
        }
      }
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error(`RPC ${url} did not become ready within ${timeoutMs}ms`);
}

async function waitForValue(getValue, label, timeoutMs = 20_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await getValue();
      if (value) {
        return value;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const suffix =
    lastError instanceof Error
      ? ` (last error: ${lastError.message})`
      : "";
  throw new Error(`Timeout while waiting for ${label}${suffix}`);
}

function buildRequest() {
  const payload = JSON.stringify({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 256,
    messages: [{ role: "user", content: "hello from local chain flow" }],
  });

  return {
    requestId: randomUUID(),
    method: "POST",
    path: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(payload),
  };
}

class MockAnthropicProvider {
  constructor() {
    this.name = "anthropic";
    this.models = ["claude-sonnet-4-5-20250929"];
    this.pricing = {
      defaults: {
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      },
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
        content: [{ type: "text", text: "Hello from local blockchain flow." }],
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

async function stopProcess(child, name) {
  if (!child) return;
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const settled = await Promise.race([
    once(child, "exit").then(() => true),
    sleep(5_000).then(() => false),
  ]);
  if (!settled && child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
  logStep(`${name} stopped`);
}

async function main() {
  requireCommand("anvil");
  requireCommand("forge");
  requireCommand("cast");

  let anvil = null;
  let bootstrap = null;
  let sellerNode = null;
  let buyerNode = null;
  let sellerDataDir = null;
  let buyerDataDir = null;

  try {
    logStep("starting local anvil chain");
    anvil = spawn(
      "anvil",
      ["--host", ANVIL_HOST, "--port", ANVIL_PORT, "--chain-id", CHAIN_ID],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    // Drain process pipes to avoid backpressure killing the child process.
    anvil.stdout?.on("data", () => undefined);
    anvil.stderr?.on("data", () => undefined);

    await waitForRpcReady(RPC_URL);
    logStep(`anvil ready at ${RPC_URL}`);

    logStep("building contracts with forge");
    runCommand("forge", ["build"], { cwd: contractsDir });

    logStep("deploying MockUSDC");
    const mockDeployOutput = runCommand(
      "forge",
      [
        "create",
        "MockUSDC.sol:MockUSDC",
        "--rpc-url",
        RPC_URL,
        "--private-key",
        DEPLOYER_PRIVATE_KEY,
        "--broadcast",
      ],
      { cwd: contractsDir }
    );
    const usdcAddress = parseDeployedAddress(mockDeployOutput);
    logStep(`MockUSDC deployed: ${usdcAddress}`);

    logStep("deploying AntseedIdentity");
    const identityDeployOutput = runCommand(
      "forge",
      [
        "create",
        "AntseedIdentity.sol:AntseedIdentity",
        "--rpc-url",
        RPC_URL,
        "--private-key",
        DEPLOYER_PRIVATE_KEY,
        "--broadcast",
      ],
      { cwd: contractsDir }
    );
    const identityAddress = parseDeployedAddress(identityDeployOutput);
    logStep(`AntseedIdentity deployed: ${identityAddress}`);

    logStep("deploying AntseedStaking");
    const stakingDeployOutput = runCommand(
      "forge",
      [
        "create",
        "AntseedStaking.sol:AntseedStaking",
        "--rpc-url",
        RPC_URL,
        "--private-key",
        DEPLOYER_PRIVATE_KEY,
        "--broadcast",
        "--constructor-args",
        usdcAddress,
        identityAddress,
      ],
      { cwd: contractsDir }
    );
    const stakingAddress = parseDeployedAddress(stakingDeployOutput);
    logStep(`AntseedStaking deployed: ${stakingAddress}`);

    logStep("deploying AntseedDeposits");
    const depositsDeployOutput = runCommand(
      "forge",
      [
        "create",
        "AntseedDeposits.sol:AntseedDeposits",
        "--rpc-url",
        RPC_URL,
        "--private-key",
        DEPLOYER_PRIVATE_KEY,
        "--broadcast",
        "--constructor-args",
        usdcAddress,
      ],
      { cwd: contractsDir }
    );
    const depositsAddress = parseDeployedAddress(depositsDeployOutput);
    logStep(`AntseedDeposits deployed: ${depositsAddress}`);

    logStep("deploying AntseedChannels");
    const sessionsDeployOutput = runCommand(
      "forge",
      [
        "create",
        "AntseedChannels.sol:AntseedChannels",
        "--rpc-url",
        RPC_URL,
        "--private-key",
        DEPLOYER_PRIVATE_KEY,
        "--broadcast",
        "--constructor-args",
        depositsAddress,
        identityAddress,
        stakingAddress,
      ],
      { cwd: contractsDir }
    );
    const channelsAddress = parseDeployedAddress(sessionsDeployOutput);
    logStep(`AntseedChannels deployed: ${channelsAddress}`);

    logStep("wiring contracts together");
    castSend([depositsAddress, "setChannelsContract(address)", channelsAddress]);
    castSend([identityAddress, "setChannelsContract(address)", channelsAddress]);
    castSend([identityAddress, "setStakingContract(address)", stakingAddress]);
    castSend([stakingAddress, "setChannelsContract(address)", channelsAddress]);
    logStep("contract wiring complete");

    logStep("starting isolated local DHT bootstrap");
    bootstrap = new DHTNode({
      // Match the same deterministic bootstrap setup used by e2e test helpers.
      peerId: toPeerId("0".repeat(40)),
      port: 0,
      bootstrapNodes: [],
      reannounceIntervalMs: 60_000,
      operationTimeoutMs: 5_000,
    });
    await bootstrap.start();
    const bootstrapConfig = [{ host: "127.0.0.1", port: bootstrap.getPort() }];
    logStep(`bootstrap DHT on 127.0.0.1:${bootstrap.getPort()}`);

    sellerDataDir = await mkdtemp(join(tmpdir(), "antseed-flow-seller-"));
    buyerDataDir = await mkdtemp(join(tmpdir(), "antseed-flow-buyer-"));

    const sellerProvider = new MockAnthropicProvider();

    logStep("starting seller node with payments enabled");
    sellerNode = new AntseedNode({
      role: "seller",
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrapConfig,
      allowPrivateIPs: true,
      payments: {
        enabled: true,
        paymentMethod: "crypto",
        settlementIdleMs: 5_000,
        defaultDepositAmountUSDC: "1000000",
        rpcUrl: RPC_URL,
        depositsAddress,
        channelsAddress,
        stakingAddress,
        identityAddress,
        usdcAddress,
      },
    });
    sellerNode.registerProvider(sellerProvider);
    await sellerNode.start();

    if (!sellerNode.identity) {
      throw new Error("seller identity unavailable after start");
    }
    const sellerAddress = sellerNode.identity.wallet.address;
    logStep(`seller peer=${sellerNode.peerId} evm=${sellerAddress}`);

    logStep("starting buyer node with payments enabled");
    buyerNode = new AntseedNode({
      role: "buyer",
      dataDir: buyerDataDir,
      dhtPort: 0,
      bootstrapNodes: bootstrapConfig,
      allowPrivateIPs: true,
      payments: {
        enabled: true,
        paymentMethod: "crypto",
        settlementIdleMs: 5_000,
        defaultDepositAmountUSDC: "1000000",
        rpcUrl: RPC_URL,
        depositsAddress,
        channelsAddress,
        stakingAddress,
        identityAddress,
        usdcAddress,
      },
    });
    await buyerNode.start();

    if (!buyerNode.identity) {
      throw new Error("buyer identity unavailable after start");
    }
    const buyerPeerId = buyerNode.peerId;
    const buyerAddress = buyerNode.identity.wallet.address;
    logStep(`buyer peer=${buyerPeerId} evm=${buyerAddress}`);

    logStep("funding buyer/seller gas balances");
    castSend([
      sellerAddress,
      "--value",
      FUND_ETH,
    ]);
    castSend([
      buyerAddress,
      "--value",
      FUND_ETH,
    ]);

    logStep(`minting ${USDC_MINT_AMOUNT} base units of USDC to buyer`);
    castSend([
      usdcAddress,
      "mint(address,uint256)",
      buyerAddress,
      USDC_MINT_AMOUNT.toString(),
    ]);

    logStep("waiting for buyer discovery of seller");
    let discoveredSeller;
    try {
      discoveredSeller = await waitForValue(
        async () => {
          // Force announce retries so discovery is deterministic on isolated local DHT.
          const announcer = sellerNode._announcer;
          if (announcer && typeof announcer.announce === "function") {
            await announcer.announce().catch(() => undefined);
          }

          const peers = await buyerNode.discoverPeers("anthropic");
          return peers.find((peer) => peer.peerId === sellerNode.peerId);
        },
        "seller discovery",
        30_000,
        500
      );
      if (!discoveredSeller.evmAddress) {
        discoveredSeller = { ...discoveredSeller, evmAddress: sellerAddress };
      }
      logStep(`buyer discovered seller ${discoveredSeller.peerId} via DHT`);
    } catch {
      // Fallback path keeps the full payment + communication flow runnable even
      // if local DHT metadata lookup is flaky on a given host.
      discoveredSeller = {
        peerId: sellerNode.peerId,
        lastSeen: Date.now(),
        providers: ["anthropic"],
        publicAddress: `127.0.0.1:${sellerNode.signalingPort}`,
        evmAddress: sellerAddress,
      };
      logStep(
        `DHT discovery timed out; falling back to direct peer address ${discoveredSeller.publicAddress}`
      );
    }

    const bpm = buyerNode.buyerPaymentManager;
    if (!bpm) {
      throw new Error("buyer payment manager was not initialized");
    }

    logStep(`depositing ${USDC_DEPOSIT_AMOUNT} base units into deposits contract from buyer`);
    let depositTx = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        depositTx = await bpm.deposit(USDC_DEPOSIT_AMOUNT);
        break;
      } catch (err) {
        if (attempt < 3 && isNonceRaceError(err)) {
          logStep(`deposit nonce race detected, retrying (attempt ${attempt + 1}/3)`);
          await sleep(500);
          continue;
        }
        throw err;
      }
    }
    logStep(`deposit tx: ${depositTx}`);

    logStep("sending buyer request across P2P path");
    const response = await buyerNode.sendRequest(discoveredSeller, buildRequest());
    if (response.statusCode !== 200) {
      throw new Error(`request failed with status=${response.statusCode}`);
    }
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    if (responseBody?.type !== "message") {
      throw new Error(`unexpected response payload: ${JSON.stringify(responseBody)}`);
    }
    logStep("request completed successfully");

    const activeSellerSession = await waitForValue(
      async () => {
        const sessions = sellerNode.getActiveSellerSessions();
        return sessions.find((session) => session.buyerPeerId === buyerNode.peerId);
      },
      "active seller payment session",
      10_000,
      250
    );
    logStep(`session established: ${activeSellerSession.sessionId}`);

    await waitForValue(
      async () => {
        const buyerSession = bpm.getSession(discoveredSeller.peerId);
        if (!buyerSession) {
          return null;
        }
        return buyerSession.lastRunningTotal > 0n ? buyerSession.lastRunningTotal : null;
      },
      "buyer receipt acknowledgement",
      15_000,
      200
    );

    logStep("sending explicit SessionEnd and waiting for on-chain settlement");
    const buyerPaymentMuxes = buyerNode._paymentMuxes;
    const sellerPaymentMux = buyerPaymentMuxes?.get(discoveredSeller.peerId);
    if (!sellerPaymentMux) {
      throw new Error("buyer payment mux for seller was not initialized");
    }
    await bpm.endSession(discoveredSeller.peerId, sellerPaymentMux, 85);

    const depositsClient = new DepositsClient({
      rpcUrl: RPC_URL,
      contractAddress: depositsAddress,
      usdcAddress,
    });
    const channelsClient = new ChannelsClient({
      rpcUrl: RPC_URL,
      contractAddress: channelsAddress,
    });

    const sellerUsdcBalance = await waitForValue(
      async () => {
        const bal = await depositsClient.getUSDCBalance(sellerAddress);
        return bal > 0n ? bal : null;
      },
      "seller USDC settlement balance",
      30_000,
      500
    );

    const buyerBalance = await depositsClient.getBuyerBalance(buyerAddress);
    const sessionInfo = await channelsClient.getSession(activeSellerSession.sessionId);

    if (buyerBalance.reserved !== 0n) {
      throw new Error(`buyer still has reserved balance after settlement: ${buyerBalance.reserved}`);
    }
    if (sessionInfo.status !== 1) {
      throw new Error(`session not settled on-chain (status=${sessionInfo.status})`);
    }

    await buyerNode.stop();
    buyerNode = null;

    logStep("flow complete: local chain deployment + P2P request + on-chain settlement verified");
    console.log(
      JSON.stringify(
        {
          rpcUrl: RPC_URL,
          chainId: CHAIN_ID,
          contracts: {
            usdc: usdcAddress,
            identity: identityAddress,
            staking: stakingAddress,
            deposits: depositsAddress,
            sessions: channelsAddress,
          },
          actors: {
            sellerPeerId: sellerNode.peerId,
            sellerAddress,
            buyerPeerId,
            buyerAddress,
          },
          session: {
            id: activeSellerSession.sessionId,
            status: sessionInfo.status,
            settledAmount: sessionInfo.settledAmount.toString(),
            score: sessionInfo.score,
          },
          balances: {
            sellerUSDC: sellerUsdcBalance.toString(),
            buyerAvailable: buyerBalance.available.toString(),
            buyerReserved: buyerBalance.reserved.toString(),
          },
        },
        null,
        2
      )
    );
  } finally {
    try {
      if (buyerNode) {
        await buyerNode.stop();
      }
    } catch {
      // best effort
    }
    try {
      if (sellerNode) {
        await sellerNode.stop();
      }
    } catch {
      // best effort
    }
    try {
      if (bootstrap) {
        await bootstrap.stop();
      }
    } catch {
      // best effort
    }
    try {
      if (sellerDataDir) {
        await rm(sellerDataDir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
    try {
      if (buyerDataDir) {
        await rm(buyerDataDir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
    await stopProcess(anvil, "anvil").catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("\n[flow] FAILED");
  console.error(formatError(err));
  process.exit(1);
});
