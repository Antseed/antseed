import { describe, it, expect } from 'vitest';
import { TypedDataEncoder, verifyTypedData, type TypedDataField } from 'ethers';
import {
  SPENDING_AUTH_TYPES,
  RESERVE_AUTH_TYPES,
  SET_OPERATOR_TYPES,
  FREE_USAGE_OPEN_TYPES,
  FREE_USAGE_AUTH_TYPES,
  makeChannelsDomain,
  makeDepositsDomain,
  makeFreeUsageDomain,
  signSpendingAuth,
  computeMetadataHash,
  ZERO_METADATA_HASH,
  type SpendingAuthMessage,
} from '../src/payments/evm/signatures.js';
import { loadOrCreateIdentity } from '../src/p2p/identity.js';
import { tmpdir } from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Solidity sources are the reference: a contract change must fail these tests.
const CONTRACTS_DIR = fileURLToPath(new URL('../../contracts', import.meta.url));
// Dependencies, Foundry tests and mocks, scripts and build output are not deployed protocol contracts.
const SKIPPED_DIRS = new Set(['lib', 'test', 'script', 'out', 'cache', 'broadcast', 'node_modules']);

function readContractSources(dir: string): string[] {
  const sources: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) sources.push(...readContractSources(join(dir, entry.name)));
    } else if (entry.name.endsWith('.sol')) {
      sources.push(readFileSync(join(dir, entry.name), 'utf8'));
    }
  }
  return sources;
}

/** Collects `name -> value` pairs, failing if two contracts disagree on one name. */
function collectUnique(sources: string[], pattern: RegExp, toEntry: (m: RegExpMatchArray) => [string, string]): Map<string, string> {
  const found = new Map<string, string>();
  for (const source of sources) {
    for (const match of source.matchAll(pattern)) {
      const [name, value] = toEntry(match);
      const previous = found.get(name);
      if (previous !== undefined && previous !== value) {
        throw new Error(`Contracts disagree on ${name}: "${previous}" vs "${value}"`);
      }
      found.set(name, value);
    }
  }
  return found;
}

const CONTRACT_SOURCES = readContractSources(CONTRACTS_DIR);

/** Primary type name -> EIP-712 type string, from `bytes32 ... constant X_TYPEHASH = keccak256("...")`. */
const SOLIDITY_TYPE_STRINGS = collectUnique(
  CONTRACT_SOURCES,
  /bytes32\s+(?:public\s+|internal\s+|private\s+)?constant\s+\w+_TYPEHASH\s*=\s*keccak256\(\s*"([^"]+)"\s*\)/g,
  (m) => [m[1]!.slice(0, m[1]!.indexOf('(')), m[1]!],
);

/** Domain name -> version, from `EIP712("name", "version")` constructor calls. */
const SOLIDITY_DOMAINS = collectUnique(
  CONTRACT_SOURCES,
  /EIP712\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g,
  (m) => [m[1]!, m[2]!],
);

const TS_TYPES: Record<string, Record<string, TypedDataField[]>> = {
  SpendingAuth: SPENDING_AUTH_TYPES,
  ReserveAuth: RESERVE_AUTH_TYPES,
  SetOperator: SET_OPERATOR_TYPES,
  FreeUsageOpen: FREE_USAGE_OPEN_TYPES,
  FreeUsageAuth: FREE_USAGE_AUTH_TYPES,
};

const TS_DOMAINS = [
  makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707'),
  makeDepositsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707'),
  makeFreeUsageDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707'),
];

describe('EIP-712 Contract Compatibility', () => {
  it('every typehash in the Solidity sources has a TS type, and the reverse', () => {
    expect([...SOLIDITY_TYPE_STRINGS.keys()].sort()).toEqual(Object.keys(TS_TYPES).sort());
  });

  it.each(Object.keys(TS_TYPES))('%s type string matches the Solidity typehash string', (primaryType) => {
    const tsTypeString = TypedDataEncoder.from(TS_TYPES[primaryType]!).encodeType(primaryType);
    expect(tsTypeString).toBe(SOLIDITY_TYPE_STRINGS.get(primaryType));
  });

  it('every EIP712 domain in the Solidity sources has a TS domain, and the reverse', () => {
    expect([...SOLIDITY_DOMAINS.keys()].sort()).toEqual(TS_DOMAINS.map((d) => d.name).sort());
  });

  it.each(TS_DOMAINS.map((d) => [d.name, d.version]))('%s domain version %s matches the Solidity constructor', (name, version) => {
    expect(version).toBe(SOLIDITY_DOMAINS.get(name as string));
  });

  it('TS SpendingAuth type string has exactly the right field order and types', () => {
    const fields = SPENDING_AUTH_TYPES.SpendingAuth;
    expect(fields).toHaveLength(3);
    expect(fields[0]).toEqual({ name: 'channelId', type: 'bytes32' });
    expect(fields[1]).toEqual({ name: 'cumulativeAmount', type: 'uint256' });
    expect(fields[2]).toEqual({ name: 'metadataHash', type: 'bytes32' });
  });

  it('Antseed domain version is "1" matching contract constructor', () => {
    const domain = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    expect(domain.name).toBe('AntseedChannels');
    expect(domain.version).toBe('1');
    expect(domain.chainId).toBe(31337);
    expect(domain.verifyingContract).toBe('0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
  });

  it('domain separator is deterministic for same inputs', () => {
    const d1 = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    const d2 = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    expect(d1).toEqual(d2);
  });

  it('different chain IDs produce different domains', () => {
    const local = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    const base = makeChannelsDomain(8453, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    expect(local.chainId).not.toBe(base.chainId);
  });

  it('reserve SpendingAuth (cumulative=0) signs and recovers correctly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity = await loadOrCreateIdentity(dir);
      const wallet = identity.wallet;
      const domain = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');

      const msg: SpendingAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 0n,
        metadataHash: ZERO_METADATA_HASH,
      };

      const sig = await signSpendingAuth(wallet, domain, msg);
      const recovered = verifyTypedData(domain, SPENDING_AUTH_TYPES, msg, sig);
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('settle SpendingAuth (cumulative>0) signs and recovers correctly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity = await loadOrCreateIdentity(dir);
      const wallet = identity.wallet;
      const domain = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');

      const msg: SpendingAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 500000n,
        metadataHash: computeMetadataHash({ cumulativeInputTokens: 5000n, cumulativeOutputTokens: 12000n, cumulativeRequestCount: 0n }),
      };

      const sig = await signSpendingAuth(wallet, domain, msg);
      const recovered = verifyTypedData(domain, SPENDING_AUTH_TYPES, msg, sig);
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('different cumulative amounts produce different SpendingAuth signatures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity = await loadOrCreateIdentity(dir);
      const wallet = identity.wallet;
      const domain = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');

      const baseMsg: SpendingAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 100000n,
        metadataHash: computeMetadataHash({ cumulativeInputTokens: 1000n, cumulativeOutputTokens: 2000n, cumulativeRequestCount: 0n }),
      };

      const sig1 = await signSpendingAuth(wallet, domain, baseMsg);
      const sig2 = await signSpendingAuth(wallet, domain, {
        ...baseMsg,
        cumulativeAmount: 200000n,
      });
      expect(sig1).not.toBe(sig2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('different channel IDs produce different signatures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity = await loadOrCreateIdentity(dir);
      const wallet = identity.wallet;
      const domain = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');

      const baseMsg: SpendingAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 100000n,
        metadataHash: ZERO_METADATA_HASH,
      };

      const sig1 = await signSpendingAuth(wallet, domain, baseMsg);
      const sig2 = await signSpendingAuth(wallet, domain, {
        ...baseMsg,
        channelId: '0x' + '02'.repeat(32),
      });
      expect(sig1).not.toBe(sig2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wrong signer is not recovered from signature', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity1 = await loadOrCreateIdentity(dir);
      const wallet1 = identity1.wallet;

      // Create a second identity in a different dir
      const dir2 = await mkdtemp(join(tmpdir(), 'eip712-test2-'));
      const identity2 = await loadOrCreateIdentity(dir2);
      const wallet2 = identity2.wallet;

      const domain = makeChannelsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
      const msg: SpendingAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 100000n,
        metadataHash: ZERO_METADATA_HASH,
      };

      // Sign with wallet1
      const sig = await signSpendingAuth(wallet1, domain, msg);
      // Recover and check it does NOT match wallet2
      const recovered = verifyTypedData(domain, SPENDING_AUTH_TYPES, msg, sig);
      expect(recovered.toLowerCase()).toBe(wallet1.address.toLowerCase());
      expect(recovered.toLowerCase()).not.toBe(wallet2.address.toLowerCase());

      await rm(dir2, { recursive: true, force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
