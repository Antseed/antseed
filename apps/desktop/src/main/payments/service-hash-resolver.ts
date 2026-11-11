/**
 * Resolves per-service usage hashes back to service (model) names.
 *
 * The buyer daemon attributes usage per service as keccak256(serviceName)
 * (getServiceMetadataId in @antseed/node). Hashing is one-way, so the reverse
 * map is built from every service name the buyer has seen advertised in
 * buyer.state.json. Names no longer advertised stay resolved for the session.
 */
import { readFile } from 'node:fs/promises';
import { getServiceMetadataId } from '@antseed/node';
import { DEFAULT_BUYER_STATE_PATH } from '../constants.js';

const hashToName = new Map<string, string>();
const hashedNames = new Set<string>();

function addName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed || hashedNames.has(trimmed)) return;
  hashedNames.add(trimmed);
  hashToName.set(getServiceMetadataId(trimmed).toLowerCase(), trimmed);
}

async function refreshFromBuyerState(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(DEFAULT_BUYER_STATE_PATH, 'utf-8')) as { discoveredPeers?: unknown };
    const peers = Array.isArray(parsed.discoveredPeers) ? parsed.discoveredPeers : [];
    for (const peer of peers) {
      const services = peer && typeof peer === 'object' ? (peer as { services?: unknown }).services : null;
      if (!Array.isArray(services)) continue;
      for (const service of services) {
        if (typeof service === 'string') addName(service);
      }
    }
  } catch {
    // No buyer state yet: resolve from what is already known.
  }
}

/** hash (lowercase) → name for the hashes given; rereads the buyer state only for unknown ones. */
export async function resolveServiceIdHashes(hashes: string[]): Promise<Map<string, string>> {
  const wanted = hashes.map((hash) => hash.toLowerCase());
  if (wanted.some((hash) => !hashToName.has(hash))) await refreshFromBuyerState();
  const resolved = new Map<string, string>();
  for (const hash of wanted) {
    const name = hashToName.get(hash);
    if (name) resolved.set(hash, name);
  }
  return resolved;
}
