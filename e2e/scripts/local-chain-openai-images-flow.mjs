#!/usr/bin/env node

/**
 * local-chain-openai-images-flow.mjs
 *
 * One-command real-chain OpenAI-compatible image generation flow:
 *   build required packages -> start fresh Anvil -> deploy contracts ->
 *   fund/register/stake/deposit -> start seller + buyer proxy ->
 *   call the Images API through Antseed -> save the generated image ->
 *   verify settlement and print a summary.
 *
 * Required:
 *   OPENAI_API_KEY=... pnpm --filter @antseed/e2e run flow:local-chain-openai-images
 *
 * Example (xAI Grok Imagine):
 *   OPENAI_API_KEY=... \
 *   OPENAI_BASE_URL=https://api.x.ai \
 *   OPENAI_IMAGE_MODEL=grok-imagine-image \
 *   pnpm --filter @antseed/e2e run flow:local-chain-openai-images
 */

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import OpenAI from "openai";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:18545";
const CHAIN_ID = Number.parseInt(process.env.CHAIN_ID ?? "31337", 10);
const rpcEndpoint = new URL(RPC_URL);
const ANVIL_HOST = process.env.ANVIL_HOST ?? rpcEndpoint.hostname;
const ANVIL_PORT = process.env.ANVIL_PORT ?? (rpcEndpoint.port || "18545");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com";
const OPENAI_PROVIDER_FLAVOR = process.env.OPENAI_PROVIDER_FLAVOR?.trim() || "";
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2";
const IMAGE_PROMPT = process.env.OPENAI_IMAGE_PROMPT?.trim() || "A tiny purple cube on a white background";
const IMAGE_COUNT = parseOptionalPositiveInt(process.env.OPENAI_IMAGE_COUNT?.trim()) ?? 1;
const DEPLOYER_PRIVATE_KEY =
  process.env.DEPLOYER_PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FLOW_FUND_ETH = process.env.FLOW_FUND_ETH ?? "1ether";
const KEEP_TEMP_DIRS = process.env.FLOW_KEEP_TEMP === "1";

// Deterministic addresses for a fresh anvil started by this script.
const CONTRACTS = {
  usdc: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  registry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  ants: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  antseedRegistry: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  staking: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
  deposits: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
  channels: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
  stats: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
  emissions: "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
  subPool: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
};

const USDC_MINT_AMOUNT = "100000000"; // 100 USDC
const USDC_STAKE_AMOUNT = "50000000"; // 50 USDC
const USDC_DEPOSIT_AMOUNT = 10_000_000n; // 10 USDC

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const contractsDir = resolve(repoRoot, "packages", "contracts");
const artifactsRoot = resolve(
  process.env.FLOW_OUTPUT_DIR ?? join(repoRoot, "e2e", "artifacts", "openai-images-local-chain"),
);

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function phase(num, title) {
  console.log(`\n${BOLD}${CYAN}=== Phase ${num}: ${title} ===${RESET}`);
}

function info(message) {
  console.log(`${YELLOW}  [INFO]${RESET} ${message}`);
}

function pass(message) {
  console.log(`${GREEN}  [PASS]${RESET} ${message}`);
}

function fail(message) {
  console.log(`${RED}  [FAIL]${RESET} ${message}`);
}

function formatError(err) {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

function parseOptionalPositiveInt(raw) {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got "${raw}"`);
  }
  return parsed;
}

function isOpenAiNativeImageModel(service) {
  return /(^|\/)(gpt-image-|dall-e)/.test(service.trim().toLowerCase());
}

function isGrokImagineImageModel(service) {
  return /(^|\/)grok-imagine-image/.test(service.trim().toLowerCase());
}

function usesFlatUnitBilling(service) {
  return isGrokImagineImageModel(service);
}

function buildKnownUnitBillingModel(service) {
  const normalized = service.trim().toLowerCase();
  if (normalized.startsWith("grok-imagine-image-quality") || normalized.startsWith("grok-imagine-image-pro")) {
    return {
      version: 1,
      components: [
        {
          unit: "output_images",
          priceUsd: 0.05,
          match: { model: service },
        },
      ],
    };
  }
  if (normalized.startsWith("grok-imagine-image")) {
    return {
      version: 1,
      components: [
        {
          unit: "output_images",
          priceUsd: 0.02,
          match: { model: service },
        },
      ],
    };
  }
  return null;
}

function buildServiceUnitBillingModelsConfig(service) {
  const configured = process.env.ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON?.trim();
  if (configured) {
    return configured;
  }
  const knownModel = buildKnownUnitBillingModel(service);
  if (!knownModel) {
    return undefined;
  }
  return JSON.stringify({
    [service]: {
      "openai-images": knownModel,
    },
  });
}

function buildImageRequest(model) {
  const request = {
    model,
    prompt: IMAGE_PROMPT,
    n: IMAGE_COUNT,
  };

  const explicitSize = process.env.OPENAI_IMAGE_SIZE?.trim();
  const explicitQuality = process.env.OPENAI_IMAGE_QUALITY?.trim();
  const explicitResolution = process.env.OPENAI_IMAGE_RESOLUTION?.trim();
  const explicitResponseFormat = process.env.OPENAI_IMAGE_RESPONSE_FORMAT?.trim();

  if (explicitSize) {
    request.size = explicitSize;
  } else if (isOpenAiNativeImageModel(model)) {
    request.size = "1024x1024";
  }

  if (explicitQuality) {
    request.quality = explicitQuality;
  } else if (isOpenAiNativeImageModel(model)) {
    request.quality = "low";
  }

  if (explicitResolution) {
    request.resolution = explicitResolution;
  }

  if (explicitResponseFormat) {
    request.response_format = explicitResponseFormat;
  }

  return request;
}

async function saveGeneratedImage(runDir, response) {
  const firstImage = response.data?.[0];
  if (!firstImage || typeof firstImage !== "object") {
    throw new Error("Images response did not include a usable data[0] item");
  }

  if (typeof firstImage.b64_json === "string" && firstImage.b64_json.length > 0) {
    const imagePath = join(runDir, "generated-image.png");
    const imageBytes = Buffer.from(firstImage.b64_json, "base64");
    await writeFile(imagePath, imageBytes);
    return {
      imagePath,
      bytes: imageBytes.length,
      source: "b64_json",
      remoteUrl: null,
    };
  }

  if (typeof firstImage.url === "string" && firstImage.url.length > 0) {
    const download = await fetch(firstImage.url);
    if (!download.ok) {
      throw new Error(`Failed to download generated image URL (${download.status} ${download.statusText})`);
    }
    const contentType = download.headers.get("content-type") ?? "";
    const extension = contentType.includes("png")
      ? ".png"
      : contentType.includes("jpeg") || contentType.includes("jpg")
        ? ".jpg"
        : contentType.includes("webp")
          ? ".webp"
          : ".bin";
    const imageBytes = Buffer.from(await download.arrayBuffer());
    const imagePath = join(runDir, `generated-image${extension}`);
    await writeFile(imagePath, imageBytes);
    return {
      imagePath,
      bytes: imageBytes.length,
      source: "url",
      remoteUrl: firstImage.url,
    };
  }

  throw new Error("Images response did not include data[0].b64_json or data[0].url");
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
    timeout: options.timeout ?? 300_000,
  });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\n${combined || "(no output)"}`,
    );
  }
  return combined;
}

function castSend(args, privateKey = DEPLOYER_PRIVATE_KEY) {
  return runCommand("cast", ["send", "--rpc-url", RPC_URL, "--private-key", privateKey, ...args]);
}

function repairProtocolWiring() {
  const deployerAddress = runCommand("cast", ["wallet", "address", "--private-key", DEPLOYER_PRIVATE_KEY]).trim();
  castSend([CONTRACTS.antseedRegistry, "setChannels(address)", CONTRACTS.channels]);
  castSend([CONTRACTS.antseedRegistry, "setStats(address)", CONTRACTS.stats]);
  castSend([CONTRACTS.antseedRegistry, "setDeposits(address)", CONTRACTS.deposits]);
  castSend([CONTRACTS.antseedRegistry, "setStaking(address)", CONTRACTS.staking]);
  castSend([CONTRACTS.antseedRegistry, "setEmissions(address)", CONTRACTS.emissions]);
  castSend([CONTRACTS.antseedRegistry, "setAntsToken(address)", CONTRACTS.ants]);
  castSend([CONTRACTS.antseedRegistry, "setIdentityRegistry(address)", CONTRACTS.registry]);
  castSend([CONTRACTS.antseedRegistry, "setProtocolReserve(address)", deployerAddress]);

  castSend([CONTRACTS.channels, "setRegistry(address)", CONTRACTS.antseedRegistry]);
  castSend([CONTRACTS.deposits, "setRegistry(address)", CONTRACTS.antseedRegistry]);
  castSend([CONTRACTS.staking, "setRegistry(address)", CONTRACTS.antseedRegistry]);
  castSend([CONTRACTS.emissions, "setRegistry(address)", CONTRACTS.antseedRegistry]);
  castSend([CONTRACTS.ants, "setRegistry(address)", CONTRACTS.antseedRegistry]);
  castSend([CONTRACTS.subPool, "setRegistry(address)", CONTRACTS.antseedRegistry]);

  castSend([CONTRACTS.stats, "setWriter(address,bool)", CONTRACTS.channels, "true"]);
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

async function isRpcReady(url) {
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
    if (!response.ok) return false;
    const payload = await response.json();
    return typeof payload?.result === "string" && payload.result.startsWith("0x");
  } catch {
    return false;
  }
}

async function addressHasCode(rpcUrl, address) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getCode",
      params: [address, "latest"],
    }),
  });
  if (!response.ok) return false;
  const payload = await response.json();
  return typeof payload?.result === "string" && payload.result !== "0x";
}

async function verifyRequiredContracts(rpcUrl, addresses) {
  const required = [
    addresses.usdc,
    addresses.registry,
    addresses.staking,
    addresses.deposits,
    addresses.channels,
    addresses.stats,
  ];
  for (const address of required) {
    if (!(await addressHasCode(rpcUrl, address))) {
      return false;
    }
  }
  return true;
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
  info(`${name} stopped`);
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

async function findOwnedAgentId(registryContract, owner, maxAgentId = 64n) {
  const normalizedOwner = owner.toLowerCase();
  for (let agentId = 1n; agentId <= maxAgentId; agentId += 1n) {
    try {
      const currentOwner = await registryContract.ownerOf(agentId);
      if (String(currentOwner).toLowerCase() === normalizedOwner) {
        return agentId;
      }
    } catch {
      // ownerOf reverts for unminted ids; skip them.
    }
  }
  return null;
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire free port")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function buildRequiredPackages() {
  phase(1, "Build Required Packages");
  runCommand("pnpm", ["run", "build:tier0"], { cwd: repoRoot, timeout: 600_000 });
  runCommand("pnpm", ["run", "build:tier1"], { cwd: repoRoot, timeout: 600_000 });
  runCommand("pnpm", ["--filter", "@antseed/provider-openai", "run", "build"], {
    cwd: repoRoot,
    timeout: 600_000,
  });
  runCommand("pnpm", ["--filter", "@antseed/cli", "run", "build"], {
    cwd: repoRoot,
    timeout: 600_000,
  });
  pass("Core packages, provider-openai, and CLI are built");
}

function ensureOpenAiApiKey() {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  ensureOpenAiApiKey();
  requireCommand("git");
  requireCommand("pnpm");
  requireCommand("anvil");
  requireCommand("forge");
  requireCommand("cast");

  await mkdir(artifactsRoot, { recursive: true });
  const runDir = join(artifactsRoot, timestampSlug());
  await mkdir(runDir, { recursive: true });

  let anvil = null;
  let bootstrap = null;
  let sellerNode = null;
  let buyerNode = null;
  let proxy = null;
  let sellerDataDir = null;
  let buyerDataDir = null;

  try {
    await buildRequiredPackages();

    phase(2, "Prepare Local Contracts");
    runCommand("git", ["submodule", "update", "--init", "packages/contracts/lib/forge-std"], {
      cwd: repoRoot,
      timeout: 300_000,
    });
    pass("forge-std submodule is ready");

    phase(3, "Start Fresh Anvil");
    if (await isRpcReady(RPC_URL)) {
      throw new Error(
        `RPC ${RPC_URL} is already serving a chain. Stop the existing Anvil or set RPC_URL to a free port for a fresh run.`,
      );
    }
    anvil = spawn(
      "anvil",
      ["--host", ANVIL_HOST, "--port", ANVIL_PORT, "--chain-id", String(CHAIN_ID)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    anvil.stdout?.on("data", () => undefined);
    anvil.stderr?.on("data", () => undefined);
    await waitForRpcReady(RPC_URL);
    pass(`Anvil ready at ${RPC_URL}`);

    phase(4, "Deploy Contracts");
    try {
      runCommand(
        "forge",
        [
          "script",
          "script/Deploy.s.sol",
          "--rpc-url",
          RPC_URL,
          "--broadcast",
          "--slow",
          "--non-interactive",
          "--skip",
          "test",
          "--skip",
          "Upgrade",
          "--skip",
          "DeployBaseMainnet",
          "--skip",
          "DeployBaseSepolia",
          "--skip",
          "DeployDiemStakingProxy",
        ],
        { cwd: contractsDir, timeout: 600_000 },
      );
      pass("Contracts deployed to fresh Anvil");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("Transaction dropped from the mempool")) {
        throw err;
      }
      const deployed = await verifyRequiredContracts(RPC_URL, CONTRACTS);
      if (!deployed) {
        throw err;
      }
      info("forge reported a dropped mempool transaction, but the required contracts are deployed; continuing");
    }
    repairProtocolWiring();
    pass("Protocol wiring verified and repaired");

    phase(5, "Load Modules and Create Identities");
    const nodeModule = await import(pathToFileURL(resolve(repoRoot, "packages/node/dist/index.js")).href);
    const buyerProxyModule = await import(pathToFileURL(resolve(repoRoot, "apps/cli/dist/proxy/buyer-proxy.js")).href);
    const providerPluginModule = await import(pathToFileURL(resolve(repoRoot, "plugins/provider-openai/dist/index.js")).href);
    const ethersModule = await import("ethers");

    const {
      AntseedNode,
      loadOrCreateIdentity,
      DepositsClient,
      DHTNode,
      toPeerId,
      signSetOperator,
      makeDepositsDomain,
    } = nodeModule;
    const { BuyerProxy } = buyerProxyModule;
    const openaiPlugin = providerPluginModule.default;
    const { Wallet, JsonRpcProvider, Contract } = ethersModule;

    sellerDataDir = await mkdtemp(join(tmpdir(), "antseed-openai-images-seller-"));
    buyerDataDir = await mkdtemp(join(tmpdir(), "antseed-openai-images-buyer-"));
    const sellerIdentity = await loadOrCreateIdentity(sellerDataDir);
    const buyerIdentity = await loadOrCreateIdentity(buyerDataDir);

    info(`seller peer=${sellerIdentity.peerId} evm=${sellerIdentity.wallet.address}`);
    info(`buyer  peer=${buyerIdentity.peerId} evm=${buyerIdentity.wallet.address}`);

    phase(6, "Fund, Register, Stake, and Deposit");
    castSend([sellerIdentity.wallet.address, "--value", FLOW_FUND_ETH]);
    castSend([buyerIdentity.wallet.address, "--value", FLOW_FUND_ETH]);
    castSend([CONTRACTS.usdc, "mint(address,uint256)", sellerIdentity.wallet.address, USDC_MINT_AMOUNT]);
    castSend([CONTRACTS.usdc, "mint(address,uint256)", buyerIdentity.wallet.address, USDC_MINT_AMOUNT]);
    castSend([CONTRACTS.registry, "register()"], sellerIdentity.wallet.privateKey);
    const registryContract = new Contract(
      CONTRACTS.registry,
      [
        "function balanceOf(address owner) view returns (uint256)",
        "function ownerOf(uint256 agentId) view returns (address)",
      ],
      new JsonRpcProvider(RPC_URL),
    );
    const sellerAgentId = await findOwnedAgentId(registryContract, sellerIdentity.wallet.address);
    if (sellerAgentId == null) {
      throw new Error(`Could not resolve seller agentId for ${sellerIdentity.wallet.address}`);
    }
    info(`seller agentId=${sellerAgentId.toString()}`);
    castSend([CONTRACTS.usdc, "approve(address,uint256)", CONTRACTS.staking, USDC_STAKE_AMOUNT], sellerIdentity.wallet.privateKey);
    castSend([CONTRACTS.staking, "stake(uint256,uint256)", sellerAgentId.toString(), USDC_STAKE_AMOUNT], sellerIdentity.wallet.privateKey);

    const buyerSigner = new Wallet(buyerIdentity.wallet.privateKey);
    const depositsDomain = makeDepositsDomain(CHAIN_ID, CONTRACTS.deposits);
    const setOperatorSig = await signSetOperator(buyerSigner, depositsDomain, {
      operator: buyerIdentity.wallet.address,
      nonce: 0n,
    });
    castSend(
      [
        CONTRACTS.deposits,
        "setOperator(address,address,uint256,bytes)",
        buyerIdentity.wallet.address,
        buyerIdentity.wallet.address,
        "0",
        setOperatorSig,
      ],
      buyerIdentity.wallet.privateKey,
    );
    castSend([CONTRACTS.usdc, "approve(address,uint256)", CONTRACTS.deposits, USDC_DEPOSIT_AMOUNT.toString()], buyerIdentity.wallet.privateKey);
    castSend([CONTRACTS.deposits, "deposit(address,uint256)", buyerIdentity.wallet.address, USDC_DEPOSIT_AMOUNT.toString()], buyerIdentity.wallet.privateKey);
    pass("Buyer and seller are funded and payment-ready");

    const depositsClient = new DepositsClient({
      rpcUrl: RPC_URL,
      contractAddress: CONTRACTS.deposits,
      usdcAddress: CONTRACTS.usdc,
      evmChainId: CHAIN_ID,
    });

    const buyerBalanceBefore = await depositsClient.getBuyerBalance(buyerIdentity.wallet.address);
    const sellerUsdcBefore = await depositsClient.getUSDCBalance(sellerIdentity.wallet.address);

    phase(7, "Start Local DHT and Seller/Buyer Nodes");
    bootstrap = new DHTNode({
      peerId: toPeerId("0".repeat(40)),
      port: 0,
      bootstrapNodes: [],
      reannounceIntervalMs: 60_000,
      operationTimeoutMs: 5_000,
    });
    await bootstrap.start();
    const bootstrapConfig = [{ host: "127.0.0.1", port: bootstrap.getPort() }];

    const serviceUnitBillingModelsJson = buildServiceUnitBillingModelsConfig(IMAGE_MODEL);
    const defaultTokenPricing = usesFlatUnitBilling(IMAGE_MODEL)
      ? { inputUsdPerMillion: "0", outputUsdPerMillion: "0" }
      : { inputUsdPerMillion: "5", outputUsdPerMillion: "40" };

    const realProvider = openaiPlugin.createProvider({
      OPENAI_API_KEY,
      OPENAI_BASE_URL,
      ANTSEED_ALLOWED_SERVICES: IMAGE_MODEL,
      ANTSEED_INPUT_USD_PER_MILLION:
        process.env.ANTSEED_INPUT_USD_PER_MILLION?.trim() ?? defaultTokenPricing.inputUsdPerMillion,
      ANTSEED_OUTPUT_USD_PER_MILLION:
        process.env.ANTSEED_OUTPUT_USD_PER_MILLION?.trim() ?? defaultTokenPricing.outputUsdPerMillion,
      ...(OPENAI_PROVIDER_FLAVOR ? { OPENAI_PROVIDER_FLAVOR } : {}),
      ...(serviceUnitBillingModelsJson ? { ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: serviceUnitBillingModelsJson } : {}),
    });

    const payments = {
      enabled: true,
      rpcUrl: RPC_URL,
      depositsAddress: CONTRACTS.deposits,
      channelsAddress: CONTRACTS.channels,
      stakingAddress: CONTRACTS.staking,
      usdcAddress: CONTRACTS.usdc,
      identityRegistryAddress: CONTRACTS.registry,
      chainId: CHAIN_ID,
      minBudgetPerRequest: "10000",
      maxPerRequestUsdc: "100000",
      maxReserveAmountUsdc: "10000000",
    };

    sellerNode = new AntseedNode({
      role: "seller",
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
      payments,
    });
    sellerNode.registerProvider(realProvider);
    await sellerNode.start();

    buyerNode = new AntseedNode({
      role: "buyer",
      dataDir: buyerDataDir,
      dhtPort: 0,
      bootstrapNodes: bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
      payments,
    });
    await buyerNode.start();
    pass("Seller and buyer nodes are online");

    phase(8, "Discover Seller and Validate Protocol Advertisement");
    const discoveredSeller = await waitForValue(
      async () => {
        const announcer = sellerNode._announcer;
        if (announcer && typeof announcer.announce === "function") {
          await announcer.announce().catch(() => undefined);
        }
        const peers = await buyerNode.discoverPeers();
        return peers.find((peer) => peer.peerId === sellerNode.peerId) ?? null;
      },
      "seller discovery",
      30_000,
      500,
    );

    const advertisedProtocols =
      discoveredSeller.providerServiceApiProtocols?.openai?.services?.[IMAGE_MODEL] ?? [];
    if (!advertisedProtocols.includes("openai-images")) {
      throw new Error(
        `Seller advertised ${IMAGE_MODEL} with protocols [${advertisedProtocols.join(", ")}], expected openai-images`,
      );
    }
    pass(`Seller advertises ${IMAGE_MODEL} as openai-images`);

    phase(9, "Start Buyer Proxy and Generate Image");
    const buyerProxyPort = await getFreePort();
    proxy = new BuyerProxy({
      node: buyerNode,
      port: buyerProxyPort,
      dataDir: buyerDataDir,
      backgroundRefreshIntervalMs: 60_000,
      peerCacheTtlMs: 1_000,
    });
    await proxy.start();

    const client = new OpenAI({
      apiKey: "antseed",
      baseURL: `http://127.0.0.1:${buyerProxyPort}/v1`,
      defaultHeaders: { "x-antseed-pin-peer": discoveredSeller.peerId },
    });

    const imageRequest = buildImageRequest(IMAGE_MODEL);
    const response = await client.images.generate(imageRequest);
    const savedImage = await saveGeneratedImage(runDir, response);
    const imagePath = savedImage.imagePath;
    pass(`Generated image saved to ${imagePath}`);

    const bpm = buyerNode.buyerPaymentManager;
    const verifiedCost = bpm?.getVerifiedCost(discoveredSeller.peerId) ?? 0n;
    const cumulativeTokens = bpm?.getCumulativeTokens(discoveredSeller.peerId) ?? { inputTokens: 0n, outputTokens: 0n };
    const responseTotals = bpm?.getResponseTokenTotals(discoveredSeller.peerId) ?? null;

    phase(10, "Stop Buyer and Verify Settlement");
    await buyerNode.stop();
    buyerNode = null;
    await sleep(8_000);

    const sellerUsdcAfter = await waitForValue(
      async () => {
        const balance = await depositsClient.getUSDCBalance(sellerIdentity.wallet.address);
        return balance > sellerUsdcBefore ? balance : null;
      },
      "seller USDC earnings",
      30_000,
      500,
    );
    const buyerBalanceAfter = await waitForValue(
      async () => {
        const balance = await depositsClient.getBuyerBalance(buyerIdentity.wallet.address);
        return balance.reserved === 0n ? balance : null;
      },
      "buyer reserved balance release",
      30_000,
      500,
    );

    const summary = {
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      contracts: CONTRACTS,
      actors: {
        sellerPeerId: sellerIdentity.peerId,
        sellerAddress: sellerIdentity.wallet.address,
        buyerPeerId: buyerIdentity.peerId,
        buyerAddress: buyerIdentity.wallet.address,
      },
      request: {
        model: IMAGE_MODEL,
        prompt: IMAGE_PROMPT,
        imageCount: IMAGE_COUNT,
        openAiBaseUrl: OPENAI_BASE_URL,
        providerFlavor: OPENAI_PROVIDER_FLAVOR || null,
        requestBody: imageRequest,
        buyerProxyBaseUrl: `http://127.0.0.1:${buyerProxyPort}/v1`,
        pinnedPeerId: discoveredSeller.peerId,
      },
      advertisedProtocols,
      image: {
        savedPath: imagePath,
        bytes: savedImage.bytes,
        source: savedImage.source,
        remoteUrl: savedImage.remoteUrl,
      },
      response: {
        created: response.created,
        usage: response.usage ?? null,
        outputCount: Array.isArray(response.data) ? response.data.length : 0,
      },
      payments: {
        verifiedCost: verifiedCost.toString(),
        cumulativeTokens: {
          input: cumulativeTokens.inputTokens.toString(),
          output: cumulativeTokens.outputTokens.toString(),
        },
        responseTotals,
        serviceUnitBillingModelsJson: serviceUnitBillingModelsJson ?? null,
      },
      balances: {
        buyerBefore: {
          available: buyerBalanceBefore.available.toString(),
          reserved: buyerBalanceBefore.reserved.toString(),
        },
        buyerAfter: {
          available: buyerBalanceAfter.available.toString(),
          reserved: buyerBalanceAfter.reserved.toString(),
        },
        sellerUsdcBefore: sellerUsdcBefore.toString(),
        sellerUsdcAfter: sellerUsdcAfter.toString(),
        sellerEarned: (sellerUsdcAfter - sellerUsdcBefore).toString(),
      },
      temp: {
        sellerDataDir,
        buyerDataDir,
      },
    };

    const summaryPath = join(runDir, "summary.json");
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    pass(`Summary written to ${summaryPath}`);

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    try {
      if (proxy) {
        await proxy.stop();
      }
    } catch {
      // best effort
    }
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
      if (!KEEP_TEMP_DIRS && sellerDataDir) {
        await rm(sellerDataDir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
    try {
      if (!KEEP_TEMP_DIRS && buyerDataDir) {
        await rm(buyerDataDir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
    await stopProcess(anvil, "anvil").catch(() => undefined);
  }
}

main().catch((err) => {
  fail("local-chain OpenAI Images flow failed");
  console.error(formatError(err));
  process.exit(1);
});
