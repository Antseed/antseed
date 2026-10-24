/** The seller pool a `stake?pool=<agentId>` link asks to open, or null for none or a malformed id. */
export function linkedPoolId(query: URLSearchParams): number | null {
  const raw = query.get('pool');
  if (!raw || !/^\d{1,15}$/.test(raw)) return null;
  const agentId = Number(raw);
  return agentId > 0 ? agentId : null;
}

/**
 * Which pool a link should open now, given the link's pool and the one the
 * link last opened: each link opens its pool once, so a drawer closed by hand
 * stays closed on data refreshes, and following a new link (or the same link
 * again after leaving it) opens that pool.
 */
export function poolToOpen(linked: number | null, lastOpened: number | null): { open: number | null; lastOpened: number | null } {
  if (linked === null) return { open: null, lastOpened: null };
  if (linked === lastOpened) return { open: null, lastOpened };
  return { open: linked, lastOpened: linked };
}
