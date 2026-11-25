/**
 * Whether this auditor is still approved on the KBF audits contract, asked while a run is going.
 *
 * The rotation is fixed at the epoch's start, so an auditor the owner removes mid-epoch keeps its
 * models in `verifier run`'s plan. The contract refuses everything it submits from then on, but
 * nothing told the run: it went on building question sets and paying sellers until its `submit` was
 * refused. `verifier run` asks this gate at the start of a tick, before a question build, before a
 * model's audits and before each seller, and stops paying once the answer is `revoked`.
 *
 * `unknown` (the chain could not be read) never stops a run: an RPC hiccup must not idle a healthy
 * auditor. `revoked` is kept for the gate's lifetime, one run, without asking again.
 */
export type AuditorApprovalState = 'approved' | 'revoked' | 'unknown'

/** Answers within this long reuse the last read, so a gate asked before every seller costs one call a minute. */
export const AUDITOR_APPROVAL_TTL_MS = 60_000

export function createAuditorApprovalGate(input: {
  /** `VerifierClient.approvedAuditor(address)`. */
  read: () => Promise<boolean>
  ttlMs?: number
  now?: () => number
  /** Called once per failed read streak. */
  warn?: (message: string) => void
}): () => Promise<AuditorApprovalState> {
  const ttlMs = input.ttlMs ?? AUDITOR_APPROVAL_TTL_MS
  const now = input.now ?? (() => Date.now())
  let last: { state: AuditorApprovalState; at: number } | null = null
  let inFlight: Promise<AuditorApprovalState> | null = null
  let warned = false
  return async () => {
    if (last?.state === 'revoked') return 'revoked'
    if (last && now() - last.at < ttlMs) return last.state
    inFlight ??= (async () => {
      let state: AuditorApprovalState
      try {
        state = await input.read() ? 'approved' : 'revoked'
        warned = false
      } catch (error) {
        state = 'unknown'
        if (!warned) {
          warned = true
          input.warn?.(`Could not read whether this auditor is still approved (${error instanceof Error ? error.message : String(error)}); the run goes on`)
        }
      }
      last = { state, at: now() }
      inFlight = null
      return state
    })()
    return inFlight
  }
}

/** Why a run stops at its start for an auditor that was in the epoch's rotation and has been removed since. */
export function auditorRemovedMessage(auditor: string, epoch: string): string {
  return `${auditor} was removed as an approved auditor during epoch ${epoch}. The contract refuses everything it submits, `
    + 'so this run stops before building questions or paying a seller, and results not submitted yet this epoch cannot be sent. '
    + '`verifier watch` can stay up: it audits nothing while the address is not approved.'
}
