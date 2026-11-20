/** The `{ ok: false, error }` answer IPC handlers give for a failure. */
export function errorResult(err: unknown): { ok: false; error: string } {
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}
