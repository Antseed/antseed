import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './deployments/runtime/artifacts.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deploymentsRoot = process.env.CONTRACT_DEPLOYMENTS_ROOT
  ? path.resolve(process.env.CONTRACT_DEPLOYMENTS_ROOT)
  : path.join(repositoryRoot, 'packages/contracts/deployments');
export const generatedChainConfigFile = path.join(
  repositoryRoot,
  'packages/node/src/payments/generated-contract-addresses.ts',
);

export const contractFields = {
  registry: 'registryContractAddress',
  usdc: 'usdcContractAddress',
  deposits: 'depositsContractAddress',
  channels: 'channelsContractAddress',
  freeUsage: 'freeUsageContractAddress',
  staking: 'stakingContractAddress',
  emissions: 'emissionsContractAddress',
  legacyEmissions: 'legacyEmissionsContractAddress',
  legacyStaking: 'legacyStakingContractAddress',
  legacyEmissionsV1: 'legacyEmissionsV1ContractAddress',
  antsToken: 'antsTokenAddress',
  identityRegistry: 'identityRegistryAddress',
  stats: 'statsContractAddress',
  depositRelay: 'depositRelayAddress',
  kbfVerification: 'verificationContractAddress',
  emissionsGate: 'emissionsGateAddress',
  sellerPools: 'sellerPoolsAddress',
  sellerRegistry: 'sellerRegistryAddress',
  positionInit: 'positionInitAddress',
  usageAccounting: 'usageAccountingAddress',
  usageRewards: 'usageRewardsAddress',
  sellerPoolsRewards: 'sellerPoolsRewardsAddress',
  legacyEmissionsEscrow: 'legacyEmissionsEscrowAddress',
};

async function readDeployment(network) {
  return JSON.parse(await readFile(path.join(deploymentsRoot, network, 'current.json'), 'utf8'));
}

/**
 * Release 003 deployed the single-auditor AntseedKbfVerification (`submitModelAudit`). The
 * round client cannot talk to it, so its address is never published as the verification
 * default; the round contract replaces it in release 004.
 */
export const SINGLE_AUDITOR_VERIFICATION_RELEASE = '003-kbf-verification';

async function readHistory(network, release) {
  try {
    return JSON.parse(await readFile(path.join(deploymentsRoot, network, 'history', `${release}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const sameAddress = (left, right) => Boolean(left && right && left.toLowerCase() === right.toLowerCase());

export function renderNetwork(record, recognizedUsageDeployment = null, singleAuditorVerification = null) {
  const values = { evmChainId: record.chainId };
  const retiredVerification = singleAuditorVerification?.contracts?.kbfVerification?.address;
  for (const [contractName, field] of Object.entries(contractFields)) {
    const contract = record.contracts[contractName];
    if (!contract) continue;
    if (contractName === 'kbfVerification' && sameAddress(contract.address, retiredVerification)) continue;
    values[field] = contract.address;
  }
  if (record.contracts.channels?.deploymentBlock != null) {
    values.channelsDeployBlock = record.contracts.channels.deploymentBlock;
  }
  if (record.contracts.stats?.deploymentBlock != null) {
    values.statsDeployBlock = record.contracts.stats.deploymentBlock;
  }
  if (values.verificationContractAddress && record.contracts.kbfVerification?.deploymentBlock != null) {
    values.verificationDeployBlock = record.contracts.kbfVerification.deploymentBlock;
  }
  if (recognizedUsageDeployment) {
    const contracts = Object.fromEntries(Object.entries(recognizedUsageDeployment.contracts)
      .map(([name, contract]) => [name, contract.address]));
    const active = record.status === 'active'
      && sameAddress(record.contracts.emissions?.address, contracts.usageAccounting)
      && sameAddress(record.contracts.staking?.address, contracts.sellerRegistry);
    const deploymentBlocks = Object.values(recognizedUsageDeployment.contracts)
      .map((contract) => contract.deploymentBlock).filter((block) => Number.isInteger(block));
    values.recognizedUsage = {
      status: active ? 'active' : 'deployed',
      effectiveEpoch: recognizedUsageDeployment.effectiveEpoch,
      ...(deploymentBlocks.length ? { deploymentBlock: Math.min(...deploymentBlocks) } : {}),
      contracts,
    };
  }
  return values;
}

export async function renderContractChainConfig() {
  const networks = ['base-mainnet', 'base-sepolia'];
  const entries = [];
  for (const network of networks) {
    const values = renderNetwork(
      await readDeployment(network),
      await readHistory(network, '001-recognized-usage-deployed'),
      await readHistory(network, SINGLE_AUDITOR_VERIFICATION_RELEASE),
    );
    const properties = Object.entries(values)
      .map(([key, value]) => {
        const rendered = typeof value === 'string' ? `'${value}'` : JSON.stringify(value, null, 2).replaceAll('\n', '\n    ');
        return `    ${key}: ${rendered},`;
      })
      .join('\n');
    entries.push(`  '${network}': {\n${properties}\n  },`);
  }

  return `// Generated by scripts/generate-contract-chain-config.mjs. Do not edit manually.\n\nexport const DEPLOYED_CONTRACT_ADDRESSES = {\n${entries.join('\n')}\n} as const;\n`;
}

export async function writeContractChainConfig() {
  await writeFileAtomic(generatedChainConfigFile, await renderContractChainConfig());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeContractChainConfig();
  console.log(`Generated ${path.relative(repositoryRoot, generatedChainConfigFile)}`);
}
