import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const contractsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.LOOP_PROOF_DIR) {
  throw new Error("LOOP_PROOF_DIR must point to the loop-proof checkout");
}
const proofDirectory = resolve(process.env.LOOP_PROOF_DIR);
const artifactDirectory = resolve(
  process.env.WASH_TRADING_ARTIFACT_DIR ?? resolve(proofDirectory, "out", "development-proof-artifacts"),
);

test("development seller proof submits end-to-end on Anvil", { timeout: 900_000 }, async (context) => {
  const artifactPath = process.env.WASH_TRADING_SELLER_PROOF
    ? resolve(process.env.WASH_TRADING_SELLER_PROOF)
    : await firstSellerArtifact(resolve(artifactDirectory, "sellers"));
  const generated = JSON.parse(await readFile(artifactPath, "utf8"));
  assert.equal(generated.version, 3);
  assert.equal(generated.kind, "antseed-wash-trading-seller-proof");
  assert.equal(generated.proofArchitecture, "direct-seller-v1");
  assert.equal(generated.securityMode, "development");
  assert.ok(generated.claimCount >= 1);
  assert.ok(BigInt(generated.provenWashVolumeRaw) > 0n);
  assert.ok(BigInt(generated.totalSellerVolumeRaw) > 0n);

  await run("forge", [
    "build",
    "integrity/AntseedWashTradingRegistry.sol",
    "test/mocks/WashTradingDevelopmentE2E.sol",
  ], contractsDirectory);

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn("anvil", ["--chain-id", "8453", "--port", String(port), "--silent"], {
    cwd: contractsDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => anvil.kill("SIGTERM"));
  await waitForRpc(rpcUrl, anvil);

  const output = await run("node", [
    "scripts/submit-wash-trading-development-anvil.mjs",
    "--artifact", artifactPath,
    "--rpc-url", rpcUrl,
    "--submit-development",
  ], contractsDirectory);
  const marker = "WASH_TRADING_DEVELOPMENT_RESULT=";
  const resultLine = output.split("\n").find((line) => line.startsWith(marker));
  assert.ok(resultLine, `missing development result in output:\n${output}`);
  const result = JSON.parse(resultLine.slice(marker.length));
  assert.equal(result.seller.toLowerCase(), generated.seller.toLowerCase());
  assert.equal(result.provenWashVolumeRaw, generated.provenWashVolumeRaw);
  assert.equal(result.totalSellerVolumeRaw, generated.totalSellerVolumeRaw);
  assert.equal(result.provenWashShareBps,
    (BigInt(generated.provenWashVolumeRaw) * 10_000n / BigInt(generated.totalSellerVolumeRaw)).toString());
  assert.equal(result.claimCount, generated.claimCount);
  assert.equal(result.authenticatedBlockReferenceCount, generated.blockReferenceCount);
  assert.equal(result.blockAuthenticationChunkCount, generated.blockAuthenticationChunkCount);
  assert.ok(BigInt(result.submissionGasUsed) > 0n);
  assert.ok(BigInt(result.authenticationGasUsed) > 0n);
  assert.ok(BigInt(result.finalizationGasUsed) > 0n);
  assert.equal(result.transactionMode, "staged-seller-proof-with-block-authentication");
  assert.equal(result.blockhashStoreMode, "development-mock");
  await assert.rejects(run("node", [
    "scripts/submit-wash-trading-development-anvil.mjs",
    "--artifact", artifactPath,
    "--rpc-url", rpcUrl,
    "--submit-development",
    "--use-chainlink-blockhash-store",
  ], contractsDirectory), /Chainlink BlockhashStore is not deployed/);
});

async function firstSellerArtifact(directory) {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no seller proof artifacts in ${directory}`);
  return resolve(directory, files[0]);
}

async function waitForRpc(rpcUrl, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`anvil exited with ${child.exitCode}`);
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) return;
    } catch { }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("anvil did not become ready");
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN ?? "1.94" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolveRun(stdout)
      : reject(new Error(`${command} ${args.join(" ")} exited with ${code}\n${stdout}\n${stderr}`)));
  });
}
