import type { NativeVideoProtocol } from '@antseed/node';
import type {
  DiscoverRow,
  ServiceCapabilitiesView,
  VprModelCatalogEntry,
  VprModelKind,
} from '../../core/state';

/** Renderer mirror of `NATIVE_VIDEO_PROTOCOLS`; the Record type keeps it exhaustive. */
const NATIVE_VIDEO_PROTOCOLS: Record<NativeVideoProtocol, true> = {
  'venice-video': true,
  'fal-video': true,
};

export function isNativeVideoProtocol(protocol: string): boolean {
  return Object.prototype.hasOwnProperty.call(NATIVE_VIDEO_PROTOCOLS, protocol);
}

export function serviceModelKind(
  protocol: string,
  capabilities: ServiceCapabilitiesView | null | undefined,
): VprModelKind {
  if (isNativeVideoProtocol(protocol)) return 'video';
  if (protocol === 'openai-images' || capabilities?.outputs?.includes('image')) return 'image';
  return 'text';
}

/**
 * Rough "from" price of one video on a route, used only to order routes and
 * models: the per-video price plus the per-second price for the shortest
 * advertised duration (one second when durations are unknown).
 */
export function videoRowStartingPrice(row: Pick<DiscoverRow,
  'minVideoUsdPerSecond' | 'minVideoUsdPerVideo' | 'capabilities'>): number | null {
  if (row.minVideoUsdPerSecond === null && row.minVideoUsdPerVideo === null) return null;
  const shortest = row.capabilities?.video?.durationsSeconds?.[0] ?? 1;
  return (row.minVideoUsdPerVideo ?? 0) + (row.minVideoUsdPerSecond ?? 0) * shortest;
}

/** Model-level counterpart of `videoRowStartingPrice` for catalog sorting. */
export function videoEntryStartingPrice(entry: Pick<VprModelCatalogEntry,
  'minVideoUsdPerSecond' | 'minVideoUsdPerVideo'>): number | null {
  if (entry.minVideoUsdPerSecond === null && entry.minVideoUsdPerVideo === null) return null;
  return (entry.minVideoUsdPerVideo ?? 0) + (entry.minVideoUsdPerSecond ?? 0);
}

export function isTextCapableRow(row: DiscoverRow): boolean {
  return serviceModelKind(row.protocol, row.capabilities) === 'text';
}

export function supportsImageEdits(row: DiscoverRow): boolean {
  return row.capabilities?.inputs?.some((input) => input.trim().toLowerCase() === 'image') ?? false;
}

export function supportsServiceParameter(row: DiscoverRow, parameter: string): boolean {
  const normalized = parameter.trim().toLowerCase();
  return normalized.length > 0 && (
    row.capabilities?.supportedParameters
      ?.some((supported) => supported.trim().toLowerCase() === normalized) ?? false
  );
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return value.toLocaleString('en-US');
}

export function modelCapabilitySummary(_entry: VprModelCatalogEntry): string[] {
  return [];
}

export function peerCapabilitySummary(row: DiscoverRow): string[] {
  const capabilities = row.capabilities;
  const summary: string[] = [];
  if (serviceModelKind(row.protocol, capabilities) === 'image' && supportsImageEdits(row)) {
    summary.push('Image editing');
  }
  if (capabilities?.contextWindow) summary.push(`${formatTokenCount(capabilities.contextWindow)} context`);
  if (capabilities?.maxOutputTokens) summary.push(`${formatTokenCount(capabilities.maxOutputTokens)} max output`);
  if (capabilities?.reasoning) summary.push('Reasoning');
  if (capabilities?.toolUse) summary.push('Tools');
  if (capabilities?.structuredOutput) summary.push('Structured output');
  return summary;
}
