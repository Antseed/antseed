import { validateKbfReferenceV1 } from '@antseed/fingerprints'
import type { KbfEpochInfo, KbfRoundClient } from '@antseed/node/payments'
import { openBank } from './sealing.js'
import { ROUND_FILE_MAX_BYTES, type RoundStorage } from './storage.js'
import type { EpochBankV1, PlanFileV1 } from './types.js'

/**
 * The committed round files every verifier reads: the plan, the sealed bank and its decryption.
 * Each is fetched against its on-chain hash, so what is read is exactly what was committed.
 */

/** The epoch's committed bank file: its URI from the latest `BankCommitted` event for its hash. */
export async function committedBankUri(client: Pick<KbfRoundClient, 'bankCommits'>, info: Pick<KbfEpochInfo, 'epoch' | 'bankHash'>): Promise<string> {
  const event = (await client.bankCommits(info.epoch)).filter((entry) => entry.bankHash === info.bankHash).at(-1)
  if (!event) throw new Error(`no BankCommitted event for epoch ${info.epoch}`)
  return event.bankUri
}

/** The sealed bank bytes, fetched against the committed hash (and cached by a caching storage). */
export async function fetchSealedBank(
  context: { client: Pick<KbfRoundClient, 'bankCommits'>; storage: Pick<RoundStorage, 'get'> },
  info: Pick<KbfEpochInfo, 'epoch' | 'bankHash'>,
): Promise<Buffer> {
  return context.storage.get(await committedBankUri(context.client, info), info.bankHash, ROUND_FILE_MAX_BYTES.bank)
}

/**
 * A bank that cannot be used whatever the attempt: the revealed key does not open the committed
 * bytes, or what it opens is not a bank of this epoch. Every verifier reaches the same verdict
 * from the same committed bytes, so the round is scored as empty instead of never attested.
 */
export class UnusableBankError extends Error {
  constructor(epoch: bigint, reason: string) {
    super(`the bank of epoch ${epoch} is unusable: ${reason}`)
    this.name = 'UnusableBankError'
  }
}

/**
 * Opens the committed bank of an epoch whose key is revealed. Fetch failures are thrown as they
 * are (they may pass); a bank that cannot be opened or is not a bank of the epoch throws
 * `UnusableBankError`. References that fail validation are dropped, so their targets go unscored
 * the same way on every verifier instead of failing the round.
 */
export async function openCommittedBank(
  context: { client: Pick<KbfRoundClient, 'bankCommits'>; storage: Pick<RoundStorage, 'get'> },
  info: Pick<KbfEpochInfo, 'epoch' | 'bankHash' | 'bankKey'>,
): Promise<EpochBankV1> {
  const sealed = await fetchSealedBank(context, info)
  let value: unknown
  try {
    value = JSON.parse(openBank(info.bankKey, sealed).toString('utf8'))
  } catch {
    throw new UnusableBankError(info.epoch, 'the revealed key does not open it')
  }
  const bank = value as Partial<EpochBankV1> | null
  if (
    !bank || bank.kind !== 'antseed-kbf-epoch-bank' || bank.version !== 1 || bank.epoch !== info.epoch.toString()
    || typeof bank.models !== 'object' || bank.models === null || Array.isArray(bank.models)
  ) {
    throw new UnusableBankError(info.epoch, 'it is not a bank of this epoch')
  }
  const models: EpochBankV1['models'] = {}
  for (const [model, reference] of Object.entries(bank.models)) {
    try {
      // Structure only: the bank's references are the publisher's, their power is not re-judged.
      models[model] = validateKbfReferenceV1(reference, { trustImported: true, minimumStatisticalPower: Number.MIN_VALUE })
    } catch {
      // Left out: its targets are not audited this epoch.
    }
  }
  return { kind: 'antseed-kbf-epoch-bank', version: 1, epoch: bank.epoch, models }
}

/** The epoch's current plan file, fetched against the on-chain plan hash and checked to belong to it. */
export async function loadPlanFile(
  context: { client: Pick<KbfRoundClient, 'planCommits'>; storage: Pick<RoundStorage, 'get'> },
  info: Pick<KbfEpochInfo, 'epoch' | 'planHash' | 'seed' | 'publisher'>,
): Promise<PlanFileV1> {
  const event = (await context.client.planCommits(info.epoch, undefined, info.publisher)).filter((entry) => entry.hash === info.planHash).at(-1)
  if (!event) throw new Error(`no PlanCommitted event for epoch ${info.epoch}`)
  let plan: PlanFileV1
  try {
    plan = JSON.parse((await context.storage.get(event.uri, info.planHash, ROUND_FILE_MAX_BYTES.plan)).toString('utf8')) as PlanFileV1
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`plan file for epoch ${info.epoch} is not JSON`)
    throw error
  }
  if (
    !isRecord(plan) || plan.kind !== 'antseed-kbf-plan' || plan.epoch !== info.epoch.toString() || plan.seed !== info.seed
    || !Array.isArray(plan.targets) || !isRecord(plan.envelopes) || !isRecord(plan.backupEnvelopes)
  ) {
    throw new Error(`plan file for epoch ${info.epoch} does not match the chain`)
  }
  return plan
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
