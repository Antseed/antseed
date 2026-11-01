import type { AbstractSigner } from 'ethers'
import type { KbfEpochInfo, KbfRoundClient } from '@antseed/node/payments'
import { checkEnvelope, isListedTarget } from './envelope-check.js'
import { loadKeySharesFile } from './key-escrow.js'
import { openKeyShare } from './key-shares.js'
import { sliceCollectors } from './plan.js'
import { fetchSealedBank, loadPlanFile } from './round-files.js'
import { openEnvelope } from './sealing.js'
import type { RoundStorage } from './storage.js'
import { targetKey, type EnvelopeSliceV1, type PlanFileV1, type RoundTargetV1 } from './types.js'

export interface PlanAcceptanceContext {
  client: Pick<
    KbfRoundClient,
    | 'hasAcceptedPlan' | 'acceptPlan' | 'keySharesCommits' | 'threshold' | 'epochVerifiers' | 'planCommits'
    | 'models' | 'bankCommits'
  >
  signer: AbstractSigner
  address: string
  encryptionPrivateKey: string
  storage: RoundStorage
  log: (message: string) => void
}

/**
 * Checks everything this verifier will rely on in the epoch's proposed round and accepts it
 * on-chain (`acceptPlan`); the plan takes effect once a majority of the verifiers other than the
 * epoch publisher did. Accepting needs:
 * - the key escrow: the epoch's threshold, shares only for epoch verifiers at distinct indexes,
 *   commitments to the committed bank key, and this verifier's own share on that polynomial;
 * - the plan: fetchable at its committed hash and belonging to the epoch's seed, with this
 *   verifier's envelopes opening and passing `checkEnvelope` and holding every slice the seed gives
 *   it that is knowable before the reveal (`missingAssignment`);
 * - the sealed bank: fetchable at its committed hash (and so kept, for scoring after the reveal).
 * A round that fails any check is never accepted, so a publisher cannot freeze the epoch with a
 * plan or escrow the others cannot use: without enough acceptances it can be taken over again.
 * Call it for an epoch this verifier is a member of but not the publisher of, before the commit deadline.
 */
export async function acceptPlan(context: PlanAcceptanceContext, info: KbfEpochInfo): Promise<void> {
  if (await context.client.hasAcceptedPlan(info.epoch, context.address)) return
  try {
    await checkRound(context, info)
  } catch (error) {
    context.log(`epoch ${info.epoch}: not accepting the plan: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const hash = await context.client.acceptPlan(context.signer, info.epoch, info.keySharesHash, info.planHash)
  context.log(`epoch ${info.epoch}: checked the plan, envelopes, bank and key escrow, and accepted them (${hash})`)
}

async function checkRound(context: PlanAcceptanceContext, info: KbfEpochInfo): Promise<void> {
  const escrow = await loadKeySharesFile(context, info)
  if (!openKeyShare(escrow, context.address, context.encryptionPrivateKey)) throw new Error('the key escrow holds no share for this verifier')

  const plan = await loadPlanFile(context, info)
  const members = await context.client.epochVerifiers(info.epoch)
  const models = await context.client.models(info.modelsVersion)
  const allowedModels = new Set(models.map((model) => model.modelHash.toLowerCase()))
  const me = context.address.toLowerCase()
  // Both envelopes, checked: an absent envelope is an empty one, so the same coverage check applies.
  const envelopes = [false, true].map((backup) => {
    const sealed = (backup ? plan.backupEnvelopes : plan.envelopes)[me]
    if (!sealed) return { backup, slices: [] as EnvelopeSliceV1[] }
    return checkEnvelope(JSON.parse(openEnvelope(context.encryptionPrivateKey, sealed).toString('utf8')), {
      epoch: info.epoch, seed: info.seed, collector: me, backup, verifiers: members, targets: plan.targets,
      allowedModels, probesPerService: info.schedule.probesPerService, slicesPerService: info.schedule.slicesPerService,
    })
  })
  const missing = missingAssignment(plan, members, info.seed, me, allowedModels, info.schedule.slicesPerService, envelopes)
  if (missing) throw new Error(`the envelopes leave out ${missing}, which the seed gives this verifier`)
  await fetchSealedBank(context, info)
}

/**
 * A slice the seed gives `me` that its envelopes leave out, if any. How many slices a target has
 * depends on the sealed bank, so only what is knowable before the reveal is required: every
 * target's first slice, and any slice up to the highest one of that target this verifier's
 * envelopes do hold. `checkEnvelope` already refuses slices that are not this verifier's.
 */
function missingAssignment(
  plan: PlanFileV1,
  members: readonly string[],
  seed: string,
  me: string,
  allowedModels: ReadonlySet<string>,
  slicesPerService: number,
  envelopes: ReadonlyArray<{ backup: boolean; slices: readonly EnvelopeSliceV1[] }>,
): string | null {
  const held = new Set(envelopes.flatMap((envelope) => envelope.slices.map((slice) => `${envelope.backup}|${targetKey(slice.target)}#${slice.sliceIndex}`)))
  const highest = new Map<string, number>()
  for (const slice of envelopes.flatMap((envelope) => envelope.slices)) {
    const key = targetKey(slice.target)
    highest.set(key, Math.max(highest.get(key) ?? 0, slice.sliceIndex))
  }
  for (const target of plan.targets as RoundTargetV1[]) {
    if (!isListedTarget(target, allowedModels)) continue
    const key = targetKey(target)
    for (let index = 0; index <= Math.min(highest.get(key) ?? 0, slicesPerService - 1); index++) {
      const collectors = sliceCollectors(members, seed, target, index)
      for (const backup of [false, true]) {
        const assigned = backup ? collectors.backup === me && collectors.owner !== me : collectors.owner === me
        if (assigned && !held.has(`${backup}|${key}#${index}`)) return `${backup ? 'backup ' : ''}slice ${index} of ${target.agentId}:${target.service}`
      }
    }
  }
  return null
}
