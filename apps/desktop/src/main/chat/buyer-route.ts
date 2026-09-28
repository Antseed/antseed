import { isRoutingSelection, type RoutingSelection } from '@antseed/node';

let pending: Promise<unknown> = Promise.resolve();

export function writeBuyerRoute(port: number, selection: RoutingSelection, preserveRouter = false): Promise<{ ok: boolean; error?: string }> {
  const update = pending.then(async () => {
    if (!isRoutingSelection(selection)) return { ok: false, error: 'Invalid routing selection' };
    const url = `http://127.0.0.1:${port}/_antseed/route`;
    if (preserveRouter) {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`Read route failed (${response.status})`);
      const current = await response.json() as { selection?: RoutingSelection };
      if (current.selection?.kind === 'router') return { ok: true };
    }
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection }), signal: AbortSignal.timeout(5_000),
    });
    const result = await response.json() as { ok?: boolean; error?: string };
    return { ok: response.ok && result.ok === true, error: result.error ?? (!response.ok ? `Route update failed (${response.status})` : undefined) };
  }).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  pending = update;
  return update;
}
