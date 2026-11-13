import type { BuyerAddressBook } from './wallet-address.js'
import { ConsoleError } from '../console-api/router.js'
import { badRequest } from '../console-api/serialize.js'
import { errorMessage } from '../errors.js'
import type { PolicyInputProblem } from '../policy-resolver.js'
import type { AuditInput, GatewayStore } from '../store.js'

/**
 * The gateway's management operations, shared by the console API handlers
 * and the `antseed gateway …` CLI. Services validate input and apply the
 * business rules (layers, narrowing, empty allow lists, last owner, …),
 * write the audit log and end sessions; they never look at who is calling.
 * Permission checks stay with the caller: the console handlers check the
 * principal, the CLI is the operator on the machine.
 *
 * Errors are `ConsoleError`s (status + code + message), which the console
 * API serializes and the CLI prints.
 */
export interface ServiceContext {
  store: GatewayStore
  dataDir: string
  now: () => number
  log: (message: string) => void
  /** Where warnings go (failed audit writes); defaults to `log`. */
  warn?: (message: string) => void
  /** Ends console sessions of a disabled member or a revoked or rotated key. */
  sessions?: { revokeMemberSessions(memberId: string): void; revokeKeySessions(keyId: string): void }
  /** The running buyer's identity → wallet address (null when unreachable); the source of truth for workspace wallets. */
  buyerAddresses?: BuyerAddressBook
}

/** Who a change is recorded against in the audit log. */
export interface Actor {
  actor: AuditInput['actor']
  ip: string | null
}

export const CLI_ACTOR: Actor = { actor: { kind: 'cli', id: null, label: 'antseed CLI' }, ip: null }

/**
 * Records one change. Never throws: a failed write is reported loudly
 * instead, since the change itself already happened.
 */
export function recordAudit(
  ctx: Pick<ServiceContext, 'store' | 'log' | 'warn'>,
  actor: Actor,
  action: string,
  target: AuditInput['target'] = null,
  details: Record<string, unknown> = {},
): void {
  try {
    ctx.store.recordAudit({ actor: actor.actor, action, target, details, ip: actor.ip })
  } catch (error) {
    (ctx.warn ?? ctx.log)(`console: AUDIT WRITE FAILED for ${action}: ${errorMessage(error)}`)
  }
}

export interface PolicyConfirmations {
  /** Save a policy whose allow list would let no seller serve. */
  confirmEmpty?: boolean
  /** Save a policy or limits that ask for more than the levels above allow. */
  acceptNarrowed?: boolean
}

/** Trimmed text input that must not be empty (or longer than `max`). */
export function requiredText(value: string, field: string, max = Infinity): string {
  const trimmed = value.trim()
  if (!trimmed) throw badRequest(`${field} is required`)
  if (trimmed.length > max) throw badRequest(`${field} is longer than ${max} characters`)
  return trimmed
}

/**
 * Policy (or limit) input that cannot be stored as sent: 400
 * `empty_allow_list` or 409 `narrowed`. `body` is the full API answer,
 * including the fields and effective policy the console shows; the CLI
 * turns the confirm flags into `--confirm-empty` / `--accept-narrowed`.
 */
export class PolicyProblemError extends ConsoleError {
  readonly body: PolicyInputProblem['body']

  constructor(problem: PolicyInputProblem) {
    super(problem.status, problem.body.error.code, problem.body.error.message)
    this.body = problem.body
  }
}

export function throwIfProblem(problem: PolicyInputProblem | null): void {
  if (problem) throw new PolicyProblemError(problem)
}

/** Field-before/after pairs of the fields that differ, for audit details. */
export function changedFields<T extends object>(before: T, after: T, fields: ReadonlyArray<keyof T>): Record<string, { before: unknown; after: unknown }> {
  const changes: Record<string, { before: unknown; after: unknown }> = {}
  for (const field of fields) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) changes[field as string] = { before: before[field], after: after[field] }
  }
  return changes
}
