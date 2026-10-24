/** The seller pool a `stake?pool=<agentId>` link asks to open, or null for none or a malformed id. */
export function linkedPoolId(query: URLSearchParams): number | null {
  const raw = query.get('pool');
  if (!raw || !/^\d{1,15}$/.test(raw)) return null;
  const agentId = Number(raw);
  return agentId > 0 ? agentId : null;
}
