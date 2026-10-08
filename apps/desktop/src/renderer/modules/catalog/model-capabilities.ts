import type {
  DiscoverRow,
  ServiceCapabilitiesView,
  VprModelCatalogEntry,
  VprModelKind,
} from '../../core/state';

export function serviceModelKind(
  protocol: string,
  capabilities: ServiceCapabilitiesView | null | undefined,
): VprModelKind {
  if (protocol === 'openai-images' || capabilities?.outputs?.includes('image')) return 'image';
  return 'text';
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
