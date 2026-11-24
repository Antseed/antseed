import { randomBytes } from 'node:crypto'
import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { KbfReferenceV1 } from '@antseed/fingerprints'
import type { MethodRun, OwnScreenFor } from '../../audit-method.js'
import { createFlipsScreen, flipsSeed, type FlipsProbe, type FlipsUnavailable } from './flips.js'
import { FLIPS_RULE, flipsCounts, isValidFlipsPair } from './flips-score.js'
import { FLIPS_THINKING } from './flips-thinking.js'
import { resolveThinking } from '../../audit-thinking.js'
import { asError } from '../../utils.js'

/**
 * FLIPS in a `verifier run`: what it makes once per run (its key, its address, its probe, its own limiters) and how it
 * builds the screen of one model from that.
 */

/**
 * The auditor's private FLIPS master for the epoch: 32 random bytes in the epoch's evidence directory (`epochDir`),
 * readable by the owner only, made once before any lane. Only the seed derived from it for one model audit and stage
 * (`flipsSeed`) is stored and published, so a publication reveals no other audit's pairs. Made atomically: written in
 * full to a file of its own, then linked into place, so a crash leaves no empty key and a concurrent run's key wins.
 * Throws when the key is unreadable or readable by others.
 */
export async function flipsMasterIn(epochDir: string, epoch: string): Promise<string> {
  const path = join(epochDir, 'flips-master.key')
  const readKey = async (): Promise<string | null> => {
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) return null
    if ((info.mode & 0o077) !== 0) {
      throw new Error(`the FLIPS key ${path} is readable by others (mode ${(info.mode & 0o777).toString(8)}): restrict it to its owner (chmod 600) and run again`)
    }
    const text = (await readFile(path, 'utf8')).trim()
    if (!/^[0-9a-f]{64}$/.test(text)) {
      throw new Error(`the FLIPS key ${path} is unreadable: rename it to start a new key for epoch ${epoch}; checks already published keep their own seeds`)
    }
    return text
  }
  const stored = await readKey()
  if (stored) return stored
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' })
  try {
    await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  const made = await readKey()
  if (!made) throw new Error(`the FLIPS key for epoch ${epoch} could not be made`)
  return made
}

/**
 * Dry run only (`ANTSEED_VERIFIER_FLIPS_PROBE`, JSON): chosen word pairs, a stage for every check, and a fresh-pairs
 * follow-up after each first flag. A probed check is a diagnostic and never counts. A value that cannot be read is no
 * probe, with the reason: it never stops the run.
 */
export function parseFlipsProbe(raw: string | undefined): { probe: FlipsProbe | null; problem: string | null } {
  if (!raw) return { probe: null, problem: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { probe: null, problem: 'ANTSEED_VERIFIER_FLIPS_PROBE is not JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { probe: null, problem: 'ANTSEED_VERIFIER_FLIPS_PROBE is not an object' }
  const value = parsed as { pairs?: unknown; stage?: unknown; followUpFirstFlags?: unknown }
  let pairs: Array<[string, string]> | undefined
  if (value.pairs !== undefined) {
    if (!Array.isArray(value.pairs) || value.pairs.length !== FLIPS_RULE.pairsPerCheck
      || !value.pairs.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string'
        && pair[0].length <= 40 && pair[1].length <= 40 && isValidFlipsPair([pair[0], pair[1]]))) {
      return { probe: null, problem: `ANTSEED_VERIFIER_FLIPS_PROBE pairs must be ${FLIPS_RULE.pairsPerCheck} pairs of two different words` }
    }
    pairs = (value.pairs as string[][]).map((pair) => [pair[0]!, pair[1]!])
  }
  if (value.stage !== undefined && value.stage !== 'first' && value.stage !== 'confirm') return { probe: null, problem: 'ANTSEED_VERIFIER_FLIPS_PROBE stage must be first or confirm' }
  if (value.followUpFirstFlags !== undefined && typeof value.followUpFirstFlags !== 'boolean') return { probe: null, problem: 'ANTSEED_VERIFIER_FLIPS_PROBE followUpFirstFlags must be true or false' }
  return {
    probe: {
      ...(pairs ? { pairs } : {}),
      ...(value.stage === 'first' || value.stage === 'confirm' ? { stage: value.stage } : {}),
      ...(value.followUpFirstFlags === true ? { followUpFirstFlags: true } : {}),
    },
    problem: null,
  }
}

/**
 * The FLIPS status of one model in one run, beside its audits: every stage with no result and why (the reference
 * failed or is unusable, a check failed, the key failed), and the probe when one is on. Best effort, never published.
 */
function flipsStatusRecorder(
  store: (status: unknown) => Promise<void>,
  model: string,
  base: { probe?: FlipsProbe; keyFailed?: string },
  warn: (line: string) => void,
) {
  const status: { version: 1; kind: 'antseed-verifier-flips-status'; model: string; probe?: FlipsProbe; keyFailed?: string; unavailable: FlipsUnavailable[] } = {
    version: 1, kind: 'antseed-verifier-flips-status', model, ...base, unavailable: [],
  }
  let tail = Promise.resolve()
  const write = (): void => {
    tail = tail.then(() => store(status)).catch(() => undefined)
  }
  write()
  return (event: FlipsUnavailable): void => {
    status.unavailable.push(event)
    warn(`FLIPS ${model} ${event.stage}: no result (${event.code}): ${event.detail}`)
    write()
  }
}

/**
 * Why a stage's sellers have no FLIPS record, from the run's status file: the run had no FLIPS at all (its key could
 * not be read), or the stage's reference failed, could not be used, or runs on a route FLIPS does not support. A
 * seller's own failure is not here: the file says what left the whole model without FLIPS. Null for anything else.
 */
export function flipsWithoutRecord(file: unknown, stage: 'first' | 'confirm'): string | null {
  if (typeof file !== 'object' || file === null || (file as { kind?: unknown }).kind !== 'antseed-verifier-flips-status') return null
  const status = file as { keyFailed?: unknown; unavailable?: unknown }
  if (typeof status.keyFailed === 'string') return `no randomness check this run: ${status.keyFailed}`
  const events = Array.isArray(status.unavailable) ? status.unavailable as Array<Partial<FlipsUnavailable>> : []
  const reference = events.find((event) => event?.stage === stage && typeof event.detail === 'string'
    && (event.code === 'reference-failed' || event.code === 'reference-unusable' || event.code === 'route-not-supported'))
  return reference ? reference.detail! : null
}

/**
 * FLIPS in one run (`RecordCheck.forRun`). Once, before any lane: the auditor's private master for the epoch
 * (`flipsMasterIn`), its address for the draw, the dry-run probe, and FLIPS's own limiters. While FLIPS does not count,
 * a failure here means no FLIPS this run, never a failed run. Then, for each model, its screen.
 */
export async function flipsForRun(run: MethodRun): Promise<OwnScreenFor<'flips'>> {
  let keyFailed: string | null = null
  const master = await flipsMasterIn(run.epochDir, run.epoch).catch((error: unknown) => {
    keyFailed = asError(error).message
    run.warn(`FLIPS: no randomness check this run: ${keyFailed}`)
    return null
  })
  // FLIPS's own limiters: its reference and seller requests never queue with the questions'. The reference's is each
  // model's own (below), so one model's 80 reference requests never wait behind another's inside their time
  // (`FLIPS_REFERENCE_TIME_LIMIT_MS`).
  const sellerLimiter = run.ownLimiters.seller()
  // Empty when it cannot be read: the seed keeps the pairs unforeseeable, the address only sets auditors apart.
  const auditor = await run.auditor()
  const parsedProbe = parseFlipsProbe(process.env['ANTSEED_VERIFIER_FLIPS_PROBE'])
  if (parsedProbe.problem) run.warn(`FLIPS: probe ignored: ${parsedProbe.problem}`)
  const probe = parsedProbe.probe
  if (probe) run.warn(`FLIPS: dry-run probe on (${JSON.stringify(probe)}): every FLIPS record is a diagnostic`)
  // The randomness check of this model's sellers (`createFlipsScreen`): its reference is asked once per stage
  // and run, on a plain route with the sellers' own body; its pairs come from this model audit's seed.
  return ({ model, seller, reference, report }) => {
    const referenceLimiter = run.ownLimiters.reference()
    const unavailable = flipsStatusRecorder(
      (status) => report.file('flips-status.json', status),
      model,
      { ...(probe && !flipsCounts(model, FLIPS_RULE) ? { probe } : {}), ...(keyFailed ? { keyFailed } : {}) },
      (line) => report.warn(line),
    )
    // A probe is a dry-run diagnostic: where FLIPS counts for this model it is refused, never run.
    const modelProbe = probe && flipsCounts(model, FLIPS_RULE) ? null : probe
    // Said as the run's own line, not above its progress, as it always was.
    if (probe && !modelProbe) run.warn(`FLIPS: probe refused for ${model}: FLIPS counts for it`)
    if (master === null) return null
    return createFlipsScreen<KbfReferenceV1>({
      model,
      auditor,
      epoch: run.epoch,
      // A resumed run keeps the seeds of the run it resumes, so an unfinished FLIPS is drawn as before (`MethodRun.runId`).
      seedFor: (stage) => flipsSeed(master, { model, epoch: run.epoch, runId: run.runId, stage }),
      ...(modelProbe ? { probe: modelProbe } : {}),
      onReady: (prepared) => report.reference(`flips-${prepared.stage}`, prepared),
      onUnavailable: unavailable,
      ...seller,
      limiter: sellerLimiter,
      // Only a route proven to serve one provider (a pinned peer, or OpenRouter pinned to one) vouches for unnamed answers.
      ask: (bank) => async (bodies, signal) => {
        const asked = await reference.replies(bank, { bodies }, { signal, limiter: referenceLimiter })
        return { ...asked, oneProvider: asked.provenOneProvider }
      },
      // The genuine model with its bank's setting where that reached 0 reasoning tokens, else the eval's switch.
      referenceThinking: (bank) => resolveThinking(FLIPS_THINKING, { model, bank, discovery: null }).reference,
    })
  }
}
