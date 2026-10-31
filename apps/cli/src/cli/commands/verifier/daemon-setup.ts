import { join } from 'node:path'
import type { AbstractSigner } from 'ethers'
import type { KbfRoundClient } from '@antseed/node/payments'
import type { AntseedConfig } from '../../../config/types.js'
import { acquirePidFileLock, type FileLock } from '../../../verifier/atomic-files.js'
import { buildEpochBank } from '../../../verifier/round/bank-builder.js'
import type { PublisherDaemonContext } from '../../../verifier/round/publisher-daemon.js'
import type { RoundStorage } from '../../../verifier/round/storage.js'
import { discoverRoundTargets, type TargetBindings } from '../../../verifier/round/target-discovery.js'

/** Fewest seconds between daemon passes. */
export const MIN_POLL_SECONDS = 10
// setTimeout clamps anything above 2^31-1 ms to 1 ms, which would poll continuously.
const MAX_TIMER_MS = 2 ** 31 - 1

/** `--interval` in milliseconds: a finite number of seconds, at least the minimum, within Node's timer range. */
export function parsePollInterval(value: string | undefined, fallbackSeconds = 60): number {
  const raw = value ?? String(fallbackSeconds)
  const seconds = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(seconds) || seconds * 1_000 > MAX_TIMER_MS) {
    throw new Error(`--interval must be a number of seconds up to ${Math.floor(MAX_TIMER_MS / 1_000)}, got "${raw}"`)
  }
  return Math.max(MIN_POLL_SECONDS, seconds) * 1_000
}

/**
 * Holds the data dir for one verifier daemon at a time. `verifier start` and `verifier publish`
 * share epoch state, the per-epoch request budget and the publisher's bank and key files, and
 * none of those are safe to read-modify-write from two processes. A lock left by a process that
 * died is taken over.
 */
export async function acquireDaemonLock(dataDir: string): Promise<FileLock> {
  const path = join(dataDir, 'verifier', 'daemon.lock')
  try {
    return await acquirePidFileLock(path)
  } catch (error) {
    if (error instanceof Error && /already active/.test(error.message)) {
      throw new Error(`another verifier start or publish is already running with the data dir ${dataDir} (lock ${path}); use a separate --data-dir per daemon`)
    }
    throw error
  }
}

/**
 * The publisher context for both `verifier publish` and a verifier standing in for a missing
 * publisher, so the two build banks and discover targets the same way.
 */
export function createPublisherContext(input: {
  config: AntseedConfig
  dataDir: string
  client: KbfRoundClient
  signer: AbstractSigner
  storage: RoundStorage
  bindings: TargetBindings
  buyerPort: number
  log: (message: string) => void
}): PublisherDaemonContext {
  const { config, dataDir, buyerPort, bindings, log } = input
  const stateDir = join(dataDir, 'verifier', 'publisher')
  return {
    client: input.client,
    signer: input.signer,
    storage: input.storage,
    stateDir,
    buildBank: ({ epoch, models, excludedProbeIds }) => buildEpochBank({
      config, epoch, models, excludedProbeIds, referencesDir: join(stateDir, 'references'), buyerPort, log,
    }),
    discoverTargets: (models) => discoverRoundTargets({ config, dataDir, models, bindings, log }),
    log,
  }
}
