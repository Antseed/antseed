#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, ContractFactory, JsonRpcProvider, Wallet, getAddress, keccak256 } from "ethers";
import { waitForLocalReceipt } from "./wash-trading-local-receipt.mjs";

const contractsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
};
const artifactPath = value("--artifact");
const useChainlinkBlockhashStore = args.includes("--use-chainlink-blockhash-store");
const rpcUrl = value("--rpc-url") ?? "http://127.0.0.1:8545";
if (!artifactPath || !args.includes("--submit-development")) {
  throw new Error("usage: submit-wash-trading-development-anvil.mjs --artifact seller-proof.json --rpc-url URL --submit-development");
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(rpcUrl)) {
  throw new Error("development seller proof submission is restricted to loopback RPC URLs");
}

const artifact = JSON.parse(await readFile(resolve(artifactPath), "utf8"));
validateArtifact(artifact);
const journal = decodeJournal(artifact.publicValues);
validateJournal(artifact, journal);
const provider = new JsonRpcProvider(rpcUrl);
provider.pollingInterval = 50;
const network = await provider.getNetwork();
if (network.chainId !== 8_453n) throw new Error(`expected chain ID 8453, got ${network.chainId}`);
const signer = new Wallet(
  process.env.ANVIL_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  provider,
);
let nonce = await provider.getTransactionCount(signer.address, "pending");

const verifier = await deploy("WashTradingDevelopmentE2E.sol/WashTradingDevelopmentVerifier.json", [
  artifact.sellerProgramVKey,
  keccak256(artifact.publicValues),
  keccak256(artifact.proofBytes),
]);
let blockhashStoreAddress = "0x78b69899C8cD252126cBB1A50171ec37286C3877";
if (useChainlinkBlockhashStore) {
  if (await provider.getCode(blockhashStoreAddress) === "0x") {
    throw new Error("Chainlink BlockhashStore is not deployed; start Anvil with a Base mainnet fork");
  }
} else {
  const blockhashStore = await deploy("WashTradingDevelopmentE2E.sol/WashTradingDevelopmentBlockhashStore.json", []);
  blockhashStoreAddress = await blockhashStore.getAddress();
  for (let offset = 0; offset < artifact.blockAuthenticationChunks.length; offset += 4) {
    const references = artifact.blockAuthenticationChunks.slice(offset, offset + 4)
      .flatMap((chunk) => chunk.references);
    await waitForLocalReceipt(provider, await blockhashStore.setBlockhashes(
      references.map((reference) => reference.number),
      references.map((reference) => reference.blockHash),
      { nonce: nonce++ },
    ));
  }
}
const registry = await deploy("AntseedWashTradingRegistry.sol/AntseedWashTradingRegistry.json", [
  await verifier.getAddress(),
  await verifier.VERIFIER_HASH(),
  blockhashStoreAddress,
  artifact.sellerProgramVKey,
  journal.periodStartBlock,
  journal.periodEndBlock,
]);
const batchAuthenticator = await deploy("WashTradingDevelopmentE2E.sol/WashTradingLocalBatchAuthenticator.json", []);

const submissionReceipt = await waitForLocalReceipt(provider, await registry.stageSellerProof(
  artifact.publicValues,
  artifact.proofBytes,
  { nonce: nonce++ },
));
const proofId = keccak256(artifact.publicValues);
if (!await registry.proofStaged(proofId)) throw new Error("seller proof was not staged");
if (await registry.proofFinalized(proofId)) throw new Error("seller proof finalized before block authentication");
let authenticationGasUsed = 0n;
for (let offset = 0; offset < artifact.blockAuthenticationChunks.length; offset += 8) {
  const chunks = artifact.blockAuthenticationChunks.slice(offset, offset + 8);
  const receipt = await waitForLocalReceipt(provider, await batchAuthenticator.authenticateChunks(
    await registry.getAddress(),
    proofId,
    chunks.map((chunk) => chunk.index),
    chunks.map((chunk) => chunk.references),
    chunks.map((chunk) => chunk.proof),
    { nonce: nonce++ },
  ));
  authenticationGasUsed += receipt.gasUsed;
}
const finalizationReceipt = await waitForLocalReceipt(provider, await registry.finalizeSellerProof(proofId, { nonce: nonce++ }));

if (!await registry.proofFinalized(proofId)) throw new Error("seller proof was not finalized");
if (await registry.provenWashVolume(journal.seller) !== journal.provenWashVolume) {
  throw new Error("onchain wash volume mismatch");
}
if (await registry.totalSellerVolume(journal.seller) !== journal.totalSellerVolume) {
  throw new Error("onchain total volume mismatch");
}
const provenWashShareBps = journal.provenWashVolume * 10_000n / journal.totalSellerVolume;
if (await registry.provenWashShareBps(journal.seller) !== provenWashShareBps) {
  throw new Error("onchain wash share mismatch");
}
if (await registry.sellerEvidenceDigest(journal.seller) !== journal.evidenceDigest) {
  throw new Error("onchain evidence digest mismatch");
}

console.log(`WASH_TRADING_DEVELOPMENT_RESULT=${JSON.stringify({
  registry: await registry.getAddress(),
  blockhashStore: blockhashStoreAddress,
  blockhashStoreMode: useChainlinkBlockhashStore ? "chainlink-base-fork" : "development-mock",
  proofId,
  seller: journal.seller,
  provenWashVolumeRaw: journal.provenWashVolume.toString(),
  totalSellerVolumeRaw: journal.totalSellerVolume.toString(),
  provenWashShareBps: provenWashShareBps.toString(),
  claimCount: artifact.claimCount,
  blockReferenceCount: Number(journal.blockReferenceCount),
  authenticatedBlockReferenceCount: Number(await registry.proofAuthenticatedBlockReferenceCount(proofId)),
  blockAuthenticationChunkCount: Number(journal.blockAuthenticationChunkCount),
  submissionGasUsed: submissionReceipt.gasUsed.toString(),
  authenticationGasUsed: authenticationGasUsed.toString(),
  finalizationGasUsed: finalizationReceipt.gasUsed.toString(),
  transactionMode: "staged-seller-proof-with-block-authentication",
})}`);

async function deploy(relativeArtifact, constructorArguments) {
  const compiled = JSON.parse(await readFile(resolve(contractsDirectory, "out", relativeArtifact), "utf8"));
  const factory = new ContractFactory(compiled.abi, compiled.bytecode.object, signer);
  const contract = await factory.deploy(...constructorArguments, { nonce: nonce++ });
  await waitForLocalReceipt(provider, contract.deploymentTransaction());
  return contract;
}

function validateArtifact(candidate) {
  if (candidate?.version !== 3 || candidate.kind !== "antseed-wash-trading-seller-proof"
    || candidate.proofArchitecture !== "direct-seller-v1" || candidate.securityMode !== "development"
    || candidate.proved !== true || candidate.verified !== true) {
    throw new Error("artifact is not a development seller proof");
  }
  for (const field of ["sellerProgramVKey", "publicValues", "proofBytes"]) {
    if (!/^0x[0-9a-f]*$/i.test(candidate[field] ?? "")) throw new Error(`${field} is invalid`);
  }
  if (candidate.proofBytes === "0x") throw new Error("development proof bytes must be nonempty");
  if (!Array.isArray(candidate.blockAuthenticationChunks)
    || candidate.blockAuthenticationChunks.length !== candidate.blockAuthenticationChunkCount) {
    throw new Error("invalid block authentication chunks");
  }
}

function decodeJournal(publicValues) {
  const [journal] = AbiCoder.defaultAbiCoder().decode([
    "tuple(uint32 schemaVersion,uint64 chainId,uint64 periodStartBlock,uint64 periodEndBlock,address seller,uint128 provenWashVolume,uint128 totalSellerVolume,bytes32 evidenceDigest,uint32 blockReferenceCount,uint32 blockAuthenticationChunkSize,uint32 blockAuthenticationChunkCount,bytes32 blockAuthenticationRoot)",
  ], publicValues);
  return {
    schemaVersion: journal.schemaVersion,
    chainId: journal.chainId,
    periodStartBlock: journal.periodStartBlock,
    periodEndBlock: journal.periodEndBlock,
    seller: getAddress(journal.seller),
    provenWashVolume: journal.provenWashVolume,
    totalSellerVolume: journal.totalSellerVolume,
    evidenceDigest: journal.evidenceDigest,
    blockReferenceCount: journal.blockReferenceCount,
    blockAuthenticationChunkSize: journal.blockAuthenticationChunkSize,
    blockAuthenticationChunkCount: journal.blockAuthenticationChunkCount,
    blockAuthenticationRoot: journal.blockAuthenticationRoot,
  };
}

function validateJournal(artifact, journal) {
  if (journal.schemaVersion !== 1n || journal.chainId !== 8_453n
    || journal.seller !== getAddress(artifact.seller)
    || journal.provenWashVolume.toString() !== artifact.provenWashVolumeRaw
    || journal.totalSellerVolume === 0n || journal.totalSellerVolume.toString() !== artifact.totalSellerVolumeRaw
    || journal.evidenceDigest.toLowerCase() !== artifact.evidenceDigest.toLowerCase()
    || Number(journal.blockReferenceCount) !== artifact.blockReferenceCount
    || Number(journal.blockAuthenticationChunkSize) !== artifact.blockAuthenticationChunkSize
    || Number(journal.blockAuthenticationChunkCount) !== artifact.blockAuthenticationChunkCount
    || journal.blockAuthenticationRoot.toLowerCase() !== artifact.blockAuthenticationRoot.toLowerCase()) {
    throw new Error("seller journal does not match artifact metadata");
  }
}
