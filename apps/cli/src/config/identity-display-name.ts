import { loadOrCreateIdentity } from '@antseed/node';
import type { AntseedConfig } from './types.js';
import { saveConfig } from './loader.js';

// Lowercased because shouldDeriveDisplayName normalizes before lookup.
const LEGACY_DEFAULT_DISPLAY_NAMES = new Set([
  'antseed node',
]);

const ADJECTIVES = [
  'amber', 'arctic', 'brisk', 'bright', 'cosmic', 'crimson', 'electric', 'ember',
  'frost', 'golden', 'lunar', 'midnight', 'neon', 'opal', 'quiet', 'radial',
  'solar', 'tidal', 'velvet', 'violet',
] as const;

const NOUNS = [
  'badger', 'falcon', 'fox', 'heron', 'lynx', 'manta', 'otter', 'panda',
  'raven', 'sparrow', 'tiger', 'wolf', 'wren', 'yak', 'orca', 'gecko',
  'ibis', 'marten', 'puma', 'swift',
] as const;

function hexNumber(hex: string, fallback: number): number {
  const parsed = Number.parseInt(hex, 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function deriveDisplayNameFromPeerId(peerId: string): string {
  const normalized = peerId.trim().toLowerCase().replace(/^0x/, '').replace(/[^0-9a-f]/g, '');
  const seed = normalized.padEnd(12, '0');
  const adjective = ADJECTIVES[hexNumber(seed.slice(0, 4), 0) % ADJECTIVES.length];
  const noun = NOUNS[hexNumber(seed.slice(4, 8), 0) % NOUNS.length];
  const suffix = seed.slice(-4);
  return `antseed-${adjective}-${noun}-${suffix}`;
}

export function shouldDeriveDisplayName(displayName: string | undefined): boolean {
  const normalized = displayName?.trim().toLowerCase();
  return !normalized || LEGACY_DEFAULT_DISPLAY_NAMES.has(normalized);
}

export async function ensureDerivedIdentityDisplayName(input: {
  config: AntseedConfig;
  configPath: string;
  dataDir: string;
  /** Persists the derived name; by default the whole config is saved to `configPath`. */
  save?: (displayName: string) => Promise<void>;
}): Promise<string> {
  if (!shouldDeriveDisplayName(input.config.identity.displayName)) {
    return input.config.identity.displayName.trim();
  }

  const identity = await loadOrCreateIdentity(input.dataDir);
  const displayName = deriveDisplayNameFromPeerId(identity.peerId);
  input.config.identity.displayName = displayName;
  if (input.save) await input.save(displayName);
  else await saveConfig(input.configPath, input.config);
  return displayName;
}
