export type BuyerDefaultRouteSelection =
  | { kind: 'model'; model: string | null }
  | { kind: 'router'; service: { peerId: string; provider: string; serviceId: string } }

export function modelDefaultRoute(peerId: string, service: string): BuyerDefaultRouteSelection {
  return { kind: 'model', model: peerId ? `${peerId}@${service}` : service };
}

export function defaultRouteModel(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const selection = (value as { selection?: unknown }).selection;
  if (!selection || typeof selection !== 'object') return '';
  const route = selection as { kind?: unknown; model?: unknown };
  return route.kind === 'model' && typeof route.model === 'string' ? route.model.trim() : '';
}
