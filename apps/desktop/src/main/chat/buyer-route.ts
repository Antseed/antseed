import { isRoutingSelection, type RoutingSelection } from '@antseed/node';
import type { DesktopRouterSelection } from '../../shared/routing-selection.js';

export type ExternalBuyerRouteChange = { router: DesktopRouterSelection } | { peerId: string; service: string };

let pending: Promise<unknown> = Promise.resolve();
let known: RoutingSelection | null = null;
let writes = 0;

function routeKey(selection: RoutingSelection): string {
  if (selection.kind === 'model') return JSON.stringify(['model', selection.model]);
  return JSON.stringify(['router', selection.service ?? null, selection.options ? Object.entries(selection.options).sort(([a], [b]) => a.localeCompare(b)) : null,
    selection.allowedModels?.map(({ provider, serviceId }) => [provider, serviceId]) ?? null]);
}

async function fetchBuyerRoute(port: number): Promise<RoutingSelection> {
  const response = await fetch(`http://127.0.0.1:${port}/_antseed/route`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Read route failed (${response.status})`);
  const current = await response.json() as { model?: unknown; router?: unknown };
  const selection = !current.model && current.router && typeof current.router === 'object'
    ? { ...current.router, kind: 'router' }
    : { kind: 'model', model: typeof current.model === 'string' && current.model.trim() ? current.model : null };
  if (!isRoutingSelection(selection)) throw new Error('Invalid buyer route');
  return selection;
}

export function readBuyerRoute(port: number): Promise<{ ok: boolean; selection?: RoutingSelection; error?: string }> {
  return pending.then(async () => ({ ok: true, selection: await fetchBuyerRoute(port) }))
    .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}

export function isBuyerRouteKnown(): boolean {
  return known !== null;
}

export function forgetBuyerRoute(): void {
  known = null;
}

/** Read the saved route and report a router set outside the desktop, or a model replacing one. */
export async function checkBuyerRoute(port: number): Promise<ExternalBuyerRouteChange | null> {
  const writesBefore = writes;
  const result = await readBuyerRoute(port);
  if (writes !== writesBefore) return null;
  if (!result.ok || !result.selection) {
    known = null;
    return null;
  }
  const previous = known;
  const current = result.selection;
  known = current;
  if (previous && routeKey(previous) === routeKey(current)) return null;
  if (current.kind === 'router') {
    return current.service ? { router: { service: current.service, options: current.options, allowedModels: current.allowedModels } } : null;
  }
  if (previous?.kind !== 'router' || !current.model) return null;
  const at = current.model.indexOf('@');
  return at > 0 ? { peerId: current.model.slice(0, at), service: current.model.slice(at + 1) } : { peerId: '', service: current.model };
}

export function writeBuyerRoute(port: number, selection: RoutingSelection, preserveRouter = false): Promise<{ ok: boolean; error?: string }> {
  const update = pending.then(async () => {
    if (!isRoutingSelection(selection)) return { ok: false, error: 'Invalid routing selection' };
    if (known && routeKey(known) === routeKey(selection)) return { ok: true };
    const url = `http://127.0.0.1:${port}/_antseed/route`;
    if (preserveRouter && (await fetchBuyerRoute(port)).kind === 'router') return { ok: true };
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(selection.kind === 'router'
        ? { model: null, router: { service: selection.service, options: selection.options, allowedModels: selection.allowedModels } }
        : { model: selection.model, router: null }), signal: AbortSignal.timeout(5_000),
    });
    const result = await response.json() as { ok?: boolean; error?: string };
    const ok = response.ok && result.ok === true;
    known = ok ? selection : null;
    writes++;
    return { ok, error: result.error ?? (!response.ok ? `Route update failed (${response.status})` : undefined) };
  }).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  pending = update;
  return update;
}
