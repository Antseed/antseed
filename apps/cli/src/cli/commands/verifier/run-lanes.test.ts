import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import nodeModule from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Command } from 'commander'
import type { PeerInfo } from '@antseed/node'
import type { AuditEpochWindow } from '../../../verifier/audit-epoch.js'
import type { RunOptions, VerifierRoundOutcome } from './run.js'

/**
 * Drives the real `runVerifierRound`. Everything that reaches the chain, the buyer, a reference or a
 * seller is replaced; planning, the lanes, status, manifests and audit windows are the real ones.
 */
type Fakes = Record<string, (...args: never[]) => unknown>
const FAKE_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  'cli/payment-utils.js': ['createVerifierClient'],
  'cli/commands/verifier/auditor-identity.js': ['resolveAuditorAddress'],
  'verifier/auditor-set.js': ['loadAuditorSetEvents'],
  'verifier/pending-confirmations.js': ['confirmationTargetsByModel', 'loadEpochAuditEvents', 'pendingConfirmations'],
  'config/loader.js': ['loadConfig'],
  'config/effective.js': ['resolveEffectiveBuyerConfig'],
  'verifier/audit-epoch.js': ['resolveAuditEpochWindow'],
  'verifier/audit-price.js': ['resolveAuditPriceCaps'],
  'verifier/ensure-auditable-reference.js': ['ensureEpochQuestionSet'],
  'verifier/model-consensus-evidence.js': ['writeModelProbeConsensusEvidence', 'writeModelAuditManifest'],
  'verifier/model-run.js': ['classifyVerificationTargetServices', 'loadBuyerProxySnapshot', 'verifyModelTarget'],
  'verifier/probe-bank.js': [
    'epochSetCalibrationProblem', 'loadEpochQuestionSet', 'missingBankReferenceExchanges',
    'reserveModelAuditReference', 'voidModelAuditReference',
  ],
  'verifier/response-auth-reader.js': ['openResponseAuthReader'],
}
const sourceRoot = new URL('../../../', import.meta.url).href
const fakeHolder = globalThis as unknown as { laneFakes: Fakes }

const { registerHooks } = nodeModule as unknown as {
  registerHooks(hooks: {
    load(url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown): unknown
  }): void
}
registerHooks({
  load(url, context, nextLoad) {
    const names = url.startsWith(sourceRoot) ? FAKE_EXPORTS[url.slice(sourceRoot.length)] : undefined
    if (!names) return nextLoad(url, context)
    // A module's own exports win over `export *`, so only the named exports are replaced.
    const fakes = names.map((name) => `export const ${name} = (...args) => globalThis.laneFakes.${name}(...args)`)
    return { format: 'module', shortCircuit: true, source: [`export * from '${url}?real'`, ...fakes].join('\n') }
  },
})

const { setAuditedModelsForTesting } = await import('../../../verifier/audited-models.js')
const { runVerifierRound, updateRetryGiveUps } = await import('./run.js')
const { readVerifierStatus } = await import('../../../verifier/audit-artifacts.js')
const { auditWindowSellersLeft, readAuditWindow } = await import('../../../verifier/audit-window.js')
const { SELLER_RETRY_SPACING_SECONDS, epochCellKey, loadEpochState, readRetryGiveUps } = await import('../../../verifier/epoch-plan.js')

setAuditedModelsForTesting({
  'model-a': { upstreamModel: 'vendor/model-a', contrastModels: [] },
  'model-b': { upstreamModel: 'vendor/model-b', contrastModels: [] },
})
console.log = () => undefined
console.warn = () => undefined

const EPOCH = '7'
const AUDITOR = '0x1111111111111111111111111111111111111111'
const nowSeconds = Math.floor(Date.now() / 1_000)
const OUTCOME_REASON = { code: 'policy_rejected', summary: 'refused', retryable: false, source: 'policy', affectedBatchCount: 0, totalBatchCount: 0, nextAction: 'none' }

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function seller(peerId: string, models: string[], refusedModels: string[] = []): PeerInfo {
  return {
    peerId, displayName: null, models, refusedModels, lastSeen: Date.now(),
    providerPricing: { openai: { services: Object.fromEntries(models.map((model) => [model, {}])) } },
  } as unknown as PeerInfo
}

function snapshot(peers: PeerInfo[]) {
  return {
    baseUrl: 'http://127.0.0.1:1', statePath: 'buyer.state.json', pid: 1, peers,
    settings: { minPeerReputation: 0, maxPricing: { inputUsdPerMillion: 1_000, outputUsdPerMillion: 1_000 } },
  }
}

interface Scenario {
  dir: string
  evidenceDir: string
  /** What happened, in order. */
  log: string[]
  window: AuditEpochWindow
  /** The buyer's snapshot for each read; the last one repeats. */
  snapshots: Array<ReturnType<typeof snapshot>>
  build: (model: string) => Promise<void>
  audit: (model: string, peerId: string, context: { proxy: unknown }) => Promise<void>
  questionSets: Set<string>
  maxConcurrentModels?: number
  /** Models whose summary can't be written. */
  brokenModels: Set<string>
  /** The confirmations waiting for this auditor, as model and seller agent id. Needs `confirm: true`. */
  confirmations: Array<{ model: string; agentId: string }>
  /** Run the auditor's assigned models (no `--all`); the auditor is approved before the epoch starts. */
  assigned: boolean
  /** A KBF audits contract is configured even without confirmations. */
  clientAvailable: boolean
  /** `approvedAuditor` on the contract; counted in `approvalReads`. */
  approved: () => Promise<boolean>
  approvalReads: number
  run(options?: Partial<RunOptions>): Promise<VerifierRoundOutcome>
}

async function withScenario(body: (scenario: Scenario) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-run-lanes-'))
  const evidenceDir = join(dir, 'evidence')
  const scenario: Scenario = {
    dir,
    evidenceDir,
    log: [],
    window: { epoch: EPOCH, startedAt: nowSeconds - 3_600, endsAt: nowSeconds + 86_400, source: 'onchain' },
    snapshots: [snapshot([seller('aa'.repeat(20), ['model-a', 'model-b'])])],
    build: async () => undefined,
    audit: async () => undefined,
    questionSets: new Set(['model-a', 'model-b']),
    brokenModels: new Set(),
    confirmations: [],
    assigned: false,
    clientAvailable: false,
    approved: async () => true,
    approvalReads: 0,
    async run(options = {}) {
      const command = new Command().option('--data-dir <path>').option('--config <path>')
      command.setOptionValue('dataDir', dir)
      command.setOptionValue('config', join(dir, 'config.json'))
      return runVerifierRound(undefined, {
        ...(scenario.assigned ? {} : { all: true }), confirm: false, skipVersionCheck: true, ...options,
      }, command)
    },
  }
  let snapshotReads = 0
  const realNow = Date.now
  fakeHolder.laneFakes = {
    createVerifierClient: () => {
      if (scenario.confirmations.length === 0 && !scenario.assigned && !scenario.clientAvailable) throw new Error('no KBF audits contract configured')
      return {
        provider: { getBlock: async () => null },
        requiredReports: async () => ({ DIFF: 2 }),
        deploymentBlock: 0,
        approvedAuditor: async () => {
          scenario.approvalReads += 1
          return scenario.approved()
        },
      }
    },
    resolveAuditorAddress: () => ({ address: AUDITOR, source: 'flag' }),
    loadAuditorSetEvents: () => (scenario.assigned
      ? [{ auditor: AUDITOR, approved: true, blockNumber: 1, logIndex: 0, timestamp: scenario.window.startedAt - 100, transactionHash: '0x01' }]
      : []),
    loadEpochAuditEvents: () => [],
    pendingConfirmations: () => [],
    confirmationTargetsByModel: () => {
      const targets = new Map<string, Map<string, unknown>>()
      for (const { model, agentId } of scenario.confirmations) {
        targets.set(model, new Map([[agentId, { agentId: BigInt(agentId), service: model, waiting: [], ownReportedAt: null }]]))
      }
      return targets
    },
    loadConfig: () => ({
      buyer: { proxyPort: 1 },
      verifier: {
        evidenceDir, banksDir: join(dir, 'banks'), referencesDir: join(dir, 'references'),
        auditMaxConcurrentModels: scenario.maxConcurrentModels,
      },
    }),
    resolveEffectiveBuyerConfig: () => ({ minPeerReputation: 0, maxPricing: { defaults: {} } }),
    resolveAuditEpochWindow: () => ({ window: scenario.window, warning: null }),
    resolveAuditPriceCaps: (_config: unknown, models: string[]) => ({
      caps: new Map(models.map((model) => [model, {
        model, source: 'configured', ratio: 1, reference: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
      }])),
      unpriced: new Map(),
    }),
    ensureEpochQuestionSet: async (input: { model: string }) => {
      scenario.log.push(`build ${input.model}`)
      await scenario.build(input.model)
      scenario.log.push(`built ${input.model}`)
    },
    writeModelProbeConsensusEvidence: (input: { model: string }) => {
      if (scenario.brokenModels.has(input.model)) throw new Error(`disk full for ${input.model}`)
      return { referenceIntegrityPaths: [] }
    },
    writeModelAuditManifest: () => undefined,
    classifyVerificationTargetServices: (peer: { models: string[]; refusedModels: string[] }, services: string[]) => {
      const service = services.find((entry) => peer.models.includes(entry))
      if (!service) return { eligible: false, code: 'model_not_advertised', service: null, reason: 'not advertised' }
      return peer.refusedModels.includes(service)
        ? { eligible: false, code: 'policy_rejected', service, reason: 'refused' }
        : { eligible: true, service }
    },
    loadBuyerProxySnapshot: async () => {
      const entry = scenario.snapshots[Math.min(snapshotReads, scenario.snapshots.length - 1)]!
      snapshotReads += 1
      return entry
    },
    verifyModelTarget: async (input: {
      target: { peerId: string }; service: string; context: { proxy: unknown }
    }) => {
      scenario.log.push(`audit ${input.service} ${input.target.peerId.slice(0, 2)}`)
      await scenario.audit(input.service, input.target.peerId, input.context)
      scenario.log.push(`audited ${input.service} ${input.target.peerId.slice(0, 2)}`)
      return {
        status: 'SKIPPED', peerId: input.target.peerId, displayName: null, agentId: null, service: input.service,
        code: 'policy_rejected', reason: 'refused', outcomeReason: OUTCOME_REASON, source: 'runtime',
        auditId: null, evidencePath: null, evidenceHash: null,
      }
    },
    epochSetCalibrationProblem: () => null,
    loadEpochQuestionSet: (input: { model: string }) => (scenario.questionSets.has(input.model) ? {} : null),
    missingBankReferenceExchanges: () => [],
    reserveModelAuditReference: (input: { model: string; sellerPeerId: string }) => ({
      auditId: `audit-${input.model}-${input.sellerPeerId}`, reference: { referenceId: `reference-${input.model}` },
    }),
    voidModelAuditReference: () => undefined,
    openResponseAuthReader: () => ({ close: () => undefined }),
  } as unknown as Fakes
  try {
    await body(scenario)
  } finally {
    Date.now = realNow
    process.exitCode = undefined
    await rm(dir, { recursive: true, force: true })
  }
}

const status = async (scenario: Scenario) => {
  const value = await readVerifierStatus(scenario.evidenceDir)
  assert.ok(value)
  return value
}
const runManifests = async (scenario: Scenario) => (await loadEpochState(scenario.evidenceDir, EPOCH)).manifests

const LANE_TIMEOUT = { timeout: 15_000 }

test('one slow build does not delay another model\'s audit', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  const otherAudited = deferred()
  // model-a's build ends only once model-b has been audited, so a run that waits for it never ends.
  scenario.build = async (model) => { if (model === 'model-a') await otherAudited.promise }
  scenario.audit = async (model) => { if (model === 'model-b') otherAudited.resolve() }

  const outcome = await scenario.run()

  assert.ok(scenario.log.indexOf('audited model-b aa') < scenario.log.indexOf('built model-a'), scenario.log.join('\n'))
  assert.ok(scenario.log.includes('audited model-a aa'))
  assert.equal(outcome.enrollmentFailures?.size, 0)
  const [manifest] = await runManifests(scenario)
  assert.deepEqual(manifest!.modelOrder, ['model-a', 'model-b'])
  const final = await status(scenario)
  assert.equal(final.state, 'completed')
  assert.equal(final.modelsCompleted, 2)
  assert.equal(final.queuedAudits, 0)
  for (const model of ['model-a', 'model-b']) assert.ok(await readAuditWindow(scenario.evidenceDir, EPOCH, model))
}))

test('a waiting build holds no audit slot, and audits stay under the cap', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.maxConcurrentModels = 1
  scenario.snapshots = [snapshot([seller('aa'.repeat(20), ['model-a']), seller('bb'.repeat(20), ['model-b'])])]
  const otherAudited = deferred()
  let active = 0
  let most = 0
  scenario.build = async (model) => { if (model === 'model-a') await otherAudited.promise }
  scenario.audit = async (model) => {
    active += 1
    most = Math.max(most, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    if (model === 'model-b') otherAudited.resolve()
  }
  await scenario.run()
  assert.equal(most, 1)
  assert.ok(scenario.log.includes('audited model-a aa'))
}))

test('a failed build stops only its model, and the run is reported as not finished', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.build = async (model) => { if (model === 'model-a') throw new Error('out of reference credit') }

  const outcome = await scenario.run()

  assert.equal(outcome.enrollmentFailures?.get('model-a'), 'out of reference credit')
  assert.ok(outcome.left >= 1)
  assert.ok(!scenario.log.some((entry) => entry.startsWith('audit model-a')))
  assert.ok(scenario.log.includes('audited model-b aa'))
  const [manifest] = await runManifests(scenario)
  assert.deepEqual(manifest!.modelOrder, ['model-b'])
  assert.deepEqual(manifest!.models.map((entry) => entry.model), ['model-b'])
  const final = await status(scenario)
  assert.equal(final.state, 'completed')
  assert.equal(final.modelsTotal, 1)
  assert.equal(final.modelsCompleted, 1)
  assert.equal(final.queuedAudits, 0)
  assert.equal(await readAuditWindow(scenario.evidenceDir, EPOCH, 'model-a'), null)
}))

test('with no model ready the status is final and no empty manifest is written', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.build = async () => { throw new Error('reference down') }

  const outcome = await scenario.run()

  assert.equal(outcome.enrollmentFailures?.size, 2)
  assert.equal(outcome.left, 2)
  assert.equal(outcome.epochChanged, undefined)
  assert.deepEqual(await runManifests(scenario), [])
  const final = await status(scenario)
  assert.equal(final.state, 'failed')
  assert.ok(final.completedAt)
  assert.equal(final.queuedAudits, 0)
}))

test('an epoch change during a build keeps the audited model and returns epochChanged', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  const otherAudited = deferred()
  scenario.build = async (model) => {
    if (model !== 'model-a') return
    await otherAudited.promise
    scenario.window = { ...scenario.window, epoch: '8' }
  }
  scenario.audit = async (model) => { if (model === 'model-b') otherAudited.resolve() }

  const outcome = await scenario.run()

  assert.equal(outcome.epochChanged, '8')
  assert.ok(!scenario.log.some((entry) => entry.startsWith('audit model-a')))
  const [manifest] = await runManifests(scenario)
  assert.deepEqual(manifest!.modelOrder, ['model-b'])
  assert.equal((await status(scenario)).queuedAudits, 0)
}))

test('an epoch change with nothing audited returns epochChanged and writes no manifest', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.build = async () => {
    scenario.window = { ...scenario.window, epoch: '8' }
    throw new Error('the build failed too')
  }

  const outcome = await scenario.run()

  assert.equal(outcome.epochChanged, '8')
  assert.equal(outcome.left, 0)
  assert.deepEqual(await runManifests(scenario), [])
  assert.equal((await status(scenario)).state, 'failed')
}))

test('--no-enroll never builds; a missing set stops that model, not the run', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.questionSets = new Set(['model-b'])

  const outcome = await scenario.run({ enroll: false })

  assert.ok(!scenario.log.some((entry) => entry.startsWith('build')))
  assert.match(outcome.enrollmentFailures?.get('model-a') ?? '', /no question set for epoch 7 yet/)
  assert.ok(outcome.left >= 1)
  assert.ok(scenario.log.includes('audited model-b aa'))
  const [manifest] = await runManifests(scenario)
  assert.deepEqual(manifest!.modelOrder, ['model-b'])
}))

test('--ignore-pre-run-checks still continues into the audit', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.questionSets = new Set(['model-b'])
  scenario.window = { ...scenario.window, source: 'utc-day' }

  const outcome = await scenario.run({ enroll: false, ignorePreRunChecks: true })

  assert.equal(outcome.enrollmentFailures?.size, 0)
  assert.ok(scenario.log.includes('audited model-a aa'))
  assert.ok(scenario.log.includes('audited model-b aa'))
}))

test('the chain is checked before any build', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.window = { ...scenario.window, source: 'utc-day' }
  await assert.rejects(scenario.run(), /the chain can't be reached/)
  assert.deepEqual(scenario.log, [])
}))

test('a lane plans again from the buyer\'s fresh peers without counting anything twice', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  const stays = 'aa'.repeat(20)
  const refused = 'bb'.repeat(20)
  const gone = 'cc'.repeat(20)
  const arrived = 'dd'.repeat(20)
  const before = snapshot([seller(stays, ['model-a']), seller(refused, ['model-a'], ['model-a']), seller(gone, ['model-a'])])
  const after = snapshot([seller(stays, ['model-a']), seller(arrived, ['model-a'])])
  scenario.snapshots = [before, after]
  const proxies = new Map<string, unknown>()
  scenario.audit = async (_model, peerId, context) => { proxies.set(peerId, context.proxy) }

  await scenario.run()

  assert.deepEqual([...proxies.keys()].sort(), [stays, arrived])
  for (const proxy of proxies.values()) assert.equal(proxy, after)
  const final = await status(scenario)
  assert.equal(final.queuedAudits, 0)
  // Both audits end SKIPPED here (`verifyModelTarget` above), and the refused seller left the plan.
  assert.equal(final.skipped, 2)
  assert.equal(final.reasonCounts?.policy_rejected, 2)
  const window = await readAuditWindow(scenario.evidenceDir, EPOCH, 'model-a')
  assert.deepEqual(window?.sellers, [stays, arrived])
}))

test('a lane whose sellers left stops without a manifest when no other model ran', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  const finished = 'aa'.repeat(20)
  const leaving = 'bb'.repeat(20)
  const finishedSeller = seller(finished, ['model-a', 'model-b'])
  scenario.snapshots = [snapshot([finishedSeller])]
  // A seller that failed waits for its retry, so the next run has nothing to do for it.
  scenario.audit = async () => { throw new Error('seller connection closed') }
  await scenario.run()
  assert.equal((await runManifests(scenario)).length, 1)

  // The second run plans the new seller, which is gone by the time the build ends.
  scenario.log.length = 0
  let reads = 0
  const withLeaving = snapshot([finishedSeller, seller(leaving, ['model-a'])])
  const withoutLeaving = snapshot([finishedSeller])
  fakeHolder.laneFakes.loadBuyerProxySnapshot = (async () => {
    reads += 1
    return reads === 1 ? withLeaving : withoutLeaving
  }) as Fakes[string]
  await rm(join(scenario.evidenceDir, 'epochs', EPOCH, 'windows'), { recursive: true, force: true })

  const outcome = await scenario.run()

  assert.equal(outcome.left, 0)
  assert.equal(outcome.enrollmentFailures?.size, 0)
  assert.equal((await runManifests(scenario)).length, 1)
  const final = await status(scenario)
  assert.equal(final.state, 'completed')
  assert.equal(final.message, 'nothing left to audit')
  assert.equal(final.queuedAudits, 0)
}))

test('a --peer seller gone after the build fails its lanes instead of the run', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  const selected = 'aa'.repeat(20)
  scenario.snapshots = [snapshot([seller(selected, ['model-a', 'model-b'])]), snapshot([seller('bb'.repeat(20), ['model-a'])])]

  const outcome = await scenario.run({ peer: selected })

  assert.equal(outcome.enrollmentFailures?.size, 2)
  assert.match(outcome.enrollmentFailures?.get('model-a') ?? '', /not present in the buyer proxy/)
  assert.deepEqual(await runManifests(scenario), [])
  assert.equal((await status(scenario)).state, 'failed')
}))

test('a buyer that stops during one build fails that lane and keeps the audited model', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  const otherAudited = deferred()
  scenario.build = async (model) => {
    if (model !== 'model-a') return
    await otherAudited.promise
    fakeHolder.laneFakes.loadBuyerProxySnapshot = (async () => { throw new Error('buyer proxy is not connected') }) as Fakes[string]
  }
  scenario.audit = async (model) => { if (model === 'model-b') otherAudited.resolve() }

  const outcome = await scenario.run()

  assert.equal(outcome.enrollmentFailures?.get('model-a'), 'buyer proxy is not connected')
  const [manifest] = await runManifests(scenario)
  assert.deepEqual(manifest!.modelOrder, ['model-b'])
}))

test('a model that started but wrote no summary stays out of the manifest, and its window stays open', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.brokenModels.add('model-a')

  const outcome = await scenario.run()

  assert.equal(outcome.enrollmentFailures?.get('model-a'), 'disk full for model-a')
  const state = await loadEpochState(scenario.evidenceDir, EPOCH)
  assert.deepEqual(state.manifests[0]!.modelOrder, ['model-b'])
  const window = await readAuditWindow(scenario.evidenceDir, EPOCH, 'model-a')
  assert.ok(window)
  assert.equal(window.state, 'open')
  assert.deepEqual(auditWindowSellersLeft(window, state), ['aa'.repeat(20)])
  assert.equal((await status(scenario)).modelsTotal, 1)
}))

const FAILING = 'bb'.repeat(20)
const STILL_LEFT = 'cc'.repeat(20)

/** Runs `body` as if the seller retry spacing had passed. */
async function afterRetrySpacing(body: () => Promise<void>): Promise<void> {
  const realNow = Date.now
  Date.now = () => realNow() + (SELLER_RETRY_SPACING_SECONDS + 60) * 1_000
  try {
    await body()
  } finally {
    Date.now = realNow
  }
}

/** A first run in which the given sellers of model-a fail, leaving each with a retry. */
async function firstRunFails(scenario: Scenario, sellers: string[]): Promise<void> {
  scenario.snapshots = [snapshot(sellers.map((peerId) => seller(peerId, ['model-a'])))]
  scenario.audit = async () => { throw new Error('seller connection closed') }
  await scenario.run()
  scenario.log.length = 0
}

const events = async (scenario: Scenario): Promise<Array<Record<string, string>>> => (
  (await readFile(join(scenario.evidenceDir, 'epochs', EPOCH, 'events.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, string>)
)

test('a seller that stopped listing the model is given up once its retry is due, and the window closes', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  await firstRunFails(scenario, [FAILING])
  await afterRetrySpacing(async () => {
    scenario.snapshots = [snapshot([seller('aa'.repeat(20), ['model-a'])])]

    const outcome = await scenario.run()

    assert.equal(outcome.left, 0)
    assert.deepEqual(scenario.log, [])
    const window = await readAuditWindow(scenario.evidenceDir, EPOCH, 'model-a')
    assert.equal(window?.state, 'closed')
    assert.deepEqual(window?.givenUpSellers, [FAILING])
    assert.match(window?.closeReason ?? '', /retry given up for 1 seller/)
    const event = (await events(scenario)).find((entry) => entry.type === 'retry-given-up')
    assert.equal(event?.peerId, FAILING)
    assert.match(event?.reason ?? '', /no longer offers model-a/)
    const cell = (await loadEpochState(scenario.evidenceDir, EPOCH)).cells.get(epochCellKey('model-a', FAILING))
    assert.equal(cell?.state, 'failed')
    assert.equal(cell?.action, 'done')
  })
}))

test('a seller still listed but no longer offering the model is given up, and one that offers it is not', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  await firstRunFails(scenario, [FAILING, STILL_LEFT])
  await afterRetrySpacing(async () => {
    await updateRetryGiveUps({
      evidenceDir: scenario.evidenceDir, epoch: EPOCH, servicesFor: () => ['model-a'],
      peers: [seller(FAILING, ['model-b']), seller(STILL_LEFT, ['model-a'])],
    })
    assert.deepEqual((await readRetryGiveUps(scenario.evidenceDir, EPOCH)).map((entry) => entry.peerId), [FAILING])
  })
}))

test('a seller gone before its retry is due keeps the retry and the window', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  await firstRunFails(scenario, [FAILING])
  scenario.snapshots = [snapshot([seller('aa'.repeat(20), ['model-a'])])]

  await scenario.run()

  assert.equal((await readAuditWindow(scenario.evidenceDir, EPOCH, 'model-a'))?.state, 'open')
  assert.equal(await readRetryGiveUps(scenario.evidenceDir, EPOCH).then((entries) => entries.length), 0)
}))

test('a run that can\'t read the buyer\'s peers gives nothing up', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  await firstRunFails(scenario, [FAILING])
  await afterRetrySpacing(async () => {
    fakeHolder.laneFakes.loadBuyerProxySnapshot = (async () => { throw new Error('buyer proxy is not connected') }) as Fakes[string]
    await assert.rejects(scenario.run(), /buyer proxy is not connected/)
    assert.equal((await readAuditWindow(scenario.evidenceDir, EPOCH, 'model-a'))?.state, 'open')
    assert.equal((await readRetryGiveUps(scenario.evidenceDir, EPOCH)).length, 0)
  })
}))

test('a stale peer list gives nothing up', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  await firstRunFails(scenario, [FAILING])
  await afterRetrySpacing(async () => {
    const stale = { ...seller('aa'.repeat(20), ['model-a']), lastSeen: Date.now() - 3_600_000 } as PeerInfo
    await updateRetryGiveUps({ evidenceDir: scenario.evidenceDir, epoch: EPOCH, peers: [stale], servicesFor: () => ['model-a'] })
    assert.equal((await readRetryGiveUps(scenario.evidenceDir, EPOCH)).length, 0)
  })
}))

test('a seller listed again before the window closes is audited as normal', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  await firstRunFails(scenario, [FAILING, STILL_LEFT])
  await afterRetrySpacing(async () => {
    // The other seller is listed but refused, so its retry keeps the window open.
    const refused = seller(STILL_LEFT, ['model-a'], ['model-a'])
    scenario.snapshots = [snapshot([refused])]
    await scenario.run()
    assert.equal((await readRetryGiveUps(scenario.evidenceDir, EPOCH)).length, 1)
    assert.equal((await readAuditWindow(scenario.evidenceDir, EPOCH, 'model-a'))?.state, 'open')

    scenario.snapshots = [snapshot([refused, seller(FAILING, ['model-a'])])]
    fakeHolder.laneFakes.loadBuyerProxySnapshot = (async () => scenario.snapshots[0]!) as Fakes[string]
    scenario.audit = async () => undefined
    await scenario.run()

    assert.ok(scenario.log.includes(`audited model-a ${FAILING.slice(0, 2)}`), scenario.log.join('\n'))
    assert.equal((await readRetryGiveUps(scenario.evidenceDir, EPOCH)).length, 0)
    assert.ok((await events(scenario)).some((entry) => entry.type === 'retry-restored'))
  })
}))

test('a seller listed again after the window closed stays given up', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  await firstRunFails(scenario, [FAILING])
  await afterRetrySpacing(async () => {
    scenario.snapshots = [snapshot([seller('aa'.repeat(20), ['model-a'])])]
    await scenario.run()

    fakeHolder.laneFakes.loadBuyerProxySnapshot = (async () => snapshot([seller(FAILING, ['model-a'])])) as Fakes[string]
    const outcome = await scenario.run()

    assert.equal(outcome.left, 0)
    assert.deepEqual(scenario.log, [])
    assert.equal((await readRetryGiveUps(scenario.evidenceDir, EPOCH)).length, 1)
  })
}))

/** Moves the wall clock, which the round's chain clock falls back to here, for the rest of the test. */
function moveClockOnce(seconds: number): () => void {
  let moved = false
  return () => {
    if (moved) return
    moved = true
    const before = Date.now
    Date.now = () => before() + seconds * 1_000
  }
}

const secondsFromNow = (seconds: number): number => Math.floor(Date.now() / 1_000) + seconds
const INTO_LAST_45_MINUTES = 20 * 60

test('a build that ends inside the last 45 minutes opens no window and starts no audit', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.window = { ...scenario.window, endsAt: secondsFromNow(3_600) }
  const moveClock = moveClockOnce(INTO_LAST_45_MINUTES)
  scenario.build = async () => { moveClock() }

  const outcome = await scenario.run()

  assert.ok(!scenario.log.some((entry) => entry.startsWith('audit ')), scenario.log.join('\n'))
  for (const model of ['model-a', 'model-b']) assert.equal(await readAuditWindow(scenario.evidenceDir, EPOCH, model), null)
  // Not a failure, and not work left: the models wait for the next epoch.
  assert.equal(outcome.left, 0)
  assert.equal(outcome.enrollmentFailures?.size, 0)
  assert.equal(process.exitCode, undefined)
  assert.deepEqual(await runManifests(scenario), [])
  const final = await status(scenario)
  assert.equal(final.state, 'completed')
  assert.equal(final.message, 'too late in the epoch to open an audit window')
  assert.equal(final.queuedAudits, 0)
  assert.equal(final.modelsTotal, 0)
}))

test('a late build stops only its model; a model already audited keeps its results', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.window = { ...scenario.window, endsAt: secondsFromNow(3_600) }
  const otherAudited = deferred()
  const moveClock = moveClockOnce(INTO_LAST_45_MINUTES)
  scenario.build = async (model) => {
    if (model !== 'model-a') return
    await otherAudited.promise
    moveClock()
  }
  scenario.audit = async (model) => { if (model === 'model-b') otherAudited.resolve() }

  const outcome = await scenario.run()

  assert.ok(!scenario.log.some((entry) => entry.startsWith('audit model-a')))
  assert.equal(await readAuditWindow(scenario.evidenceDir, EPOCH, 'model-a'), null)
  assert.equal(outcome.enrollmentFailures?.size, 0)
  const [manifest] = await runManifests(scenario)
  assert.deepEqual(manifest!.modelOrder, ['model-b'])
  const final = await status(scenario)
  assert.equal(final.modelsTotal, 1)
  assert.equal(final.queuedAudits, 0)
}))

test('a model whose window is open keeps finishing past the cutoff', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  await firstRunFails(scenario, [FAILING])
  await afterRetrySpacing(async () => {
    scenario.window = { ...scenario.window, endsAt: secondsFromNow(3_600) }
    scenario.audit = async () => undefined
    scenario.snapshots = [snapshot([seller(FAILING, ['model-a']), seller(STILL_LEFT, ['model-b'])])]
    fakeHolder.laneFakes.loadBuyerProxySnapshot = (async () => scenario.snapshots[0]!) as Fakes[string]
    const moveClock = moveClockOnce(INTO_LAST_45_MINUTES)
    // model-b, which has no window yet, meets the cutoff first; model-a's build ends after that.
    scenario.build = async (model) => {
      if (model === 'model-b') moveClock()
      else await new Promise((resolve) => setTimeout(resolve, 100))
    }

    await scenario.run()

    assert.ok(scenario.log.includes(`audited model-a ${FAILING.slice(0, 2)}`), scenario.log.join('\n'))
    assert.ok(!scenario.log.some((entry) => entry.startsWith('audit model-b')), scenario.log.join('\n'))
    assert.equal(await readAuditWindow(scenario.evidenceDir, EPOCH, 'model-b'), null)
  })
}))

test('a build that ends with time to spare still opens its window and audits', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.window = { ...scenario.window, endsAt: secondsFromNow(3_600) }
  const moveClock = moveClockOnce(10 * 60)
  scenario.build = async () => { moveClock() }

  await scenario.run()

  for (const model of ['model-a', 'model-b']) {
    assert.ok(scenario.log.includes(`audited ${model} aa`), scenario.log.join('\n'))
    assert.ok(await readAuditWindow(scenario.evidenceDir, EPOCH, model))
  }
}))

test('a model that waits for an audit slot past the cutoff opens no window', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.maxConcurrentModels = 1
  scenario.window = { ...scenario.window, endsAt: secondsFromNow(3_600) }
  scenario.snapshots = [snapshot([seller('aa'.repeat(20), ['model-a']), seller('bb'.repeat(20), ['model-b'])])]
  const moveClock = moveClockOnce(INTO_LAST_45_MINUTES)
  scenario.audit = async () => {
    // Long enough for the other lane to be through its build and waiting for this slot.
    await new Promise((resolve) => setTimeout(resolve, 100))
    moveClock()
  }

  const outcome = await scenario.run()

  const audited = scenario.log.filter((entry) => entry.startsWith('audited '))
  assert.equal(audited.length, 1, scenario.log.join('\n'))
  const waited = audited[0]!.includes('model-a') ? 'model-b' : 'model-a'
  assert.equal(await readAuditWindow(scenario.evidenceDir, EPOCH, waited), null)
  assert.equal(outcome.enrollmentFailures?.size, 0)
  assert.equal((await status(scenario)).queuedAudits, 0)
}))

test('past the cutoff a model\'s confirmations are still audited, outside any window', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  const confirming = 'aa'.repeat(20)
  const other = 'bb'.repeat(20)
  scenario.window = { ...scenario.window, endsAt: secondsFromNow(3_600) }
  scenario.confirmations = [{ model: 'model-a', agentId: '5' }]
  scenario.snapshots = [snapshot([
    { ...seller(confirming, ['model-a']), onChainAgentId: 5 } as PeerInfo,
    seller(other, ['model-a']),
  ])]
  const moveClock = moveClockOnce(INTO_LAST_45_MINUTES)
  scenario.build = async () => { moveClock() }

  const outcome = await scenario.run({ confirm: true })

  assert.ok(scenario.log.includes('audited model-a aa'), scenario.log.join('\n'))
  assert.ok(!scenario.log.includes('audit model-a bb'))
  assert.equal(await readAuditWindow(scenario.evidenceDir, EPOCH, 'model-a'), null)
  assert.equal(outcome.enrollmentFailures?.size, 0)
  assert.deepEqual((await runManifests(scenario))[0]!.modelOrder, ['model-a'])
}))

test('a question set that can\'t be used is no failure once the model is past the cutoff', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.window = { ...scenario.window, endsAt: secondsFromNow(3_600) }
  scenario.questionSets = new Set()
  const moveClock = moveClockOnce(INTO_LAST_45_MINUTES)
  scenario.build = async () => { moveClock() }

  const outcome = await scenario.run()

  assert.equal(outcome.left, 0)
  assert.equal(outcome.enrollmentFailures?.size, 0)
}))

test('a model whose window is closed is left out of a later run instead of failing as not advertised', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  const first = { ...seller('aa'.repeat(20), ['model-a', 'model-b']), onChainAgentId: 5 } as PeerInfo
  scenario.snapshots = [snapshot([first])]
  await scenario.run()
  assert.equal((await readAuditWindow(scenario.evidenceDir, EPOCH, 'model-a'))?.state, 'closed')

  // A later tick has other work: a confirmation on model-b for a seller that was not in its window.
  scenario.log.length = 0
  scenario.confirmations = [{ model: 'model-b', agentId: '6' }]
  scenario.snapshots = [snapshot([first, { ...seller('bb'.repeat(20), ['model-b']), onChainAgentId: 6 } as PeerInfo])]

  const outcome = await scenario.run({ confirm: true })

  assert.ok(scenario.log.includes('audited model-b bb'), scenario.log.join('\n'))
  assert.ok(!scenario.log.some((line) => line.includes('model-a')), scenario.log.join('\n'))
  assert.equal(outcome.failed, false)
  assert.equal((await status(scenario)).failures, 0)
  assert.equal(outcome.left, 0)
}))

test('a round says whether an audit failed in it, for the command\'s exit code', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.snapshots = [snapshot([seller('aa'.repeat(20), ['model-a'])])]
  scenario.audit = async () => { throw new Error('seller connection closed') }
  assert.equal((await scenario.run()).failed, true)
  assert.equal(process.exitCode, undefined, 'the round does not set the exit code; the last round of the command decides')
}))

test('assigned mode: an auditor removed before the run starts builds nothing and pays nobody', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.assigned = true
  scenario.approved = async () => false
  await assert.rejects(scenario.run(), /was removed as an approved auditor during epoch 7/)
  assert.deepEqual(scenario.log, [])
}))

test('assigned mode: a removal during the run stops the next seller audit, and later models are not audited', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.assigned = true
  scenario.maxConcurrentModels = 1
  scenario.snapshots = [snapshot([seller('aa'.repeat(20), ['model-a']), seller('bb'.repeat(20), ['model-b'])])]
  let approved = true
  scenario.approved = async () => approved
  const realNow = Date.now
  scenario.audit = async (model) => {
    if (model !== 'model-a') return
    // The owner removes the auditor while model-a is audited; the gate reads it again after its minute.
    approved = false
    Date.now = () => realNow() + 120_000
  }
  await scenario.run()
  const audited = scenario.log.filter((line) => line.startsWith('audit '))
  assert.equal(audited.length, 1, scenario.log.join('\n'))
  assert.ok(scenario.approvalReads >= 2, `approval read ${scenario.approvalReads} times`)
}))

test('assigned mode: an approval that cannot be read never stops a run', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.assigned = true
  scenario.approved = async () => { throw new Error('rpc down') }
  await scenario.run()
  assert.ok(scenario.log.includes('audited model-a aa'), scenario.log.join('\n'))
  assert.ok(scenario.log.includes('audited model-b aa'), scenario.log.join('\n'))
}))

test('--all never asks for the approval: an unapproved auditor can try an audit', LANE_TIMEOUT, () => withScenario(async (scenario) => {
  scenario.clientAvailable = true
  scenario.approved = async () => false
  await scenario.run()
  assert.equal(scenario.approvalReads, 0)
  assert.ok(scenario.log.includes('audited model-a aa'), scenario.log.join('\n'))
}))

test('the command\'s exit code: a failure in round 1 that round 2 finishes is 0, a failure in the last round is 1', async () => {
  const { runCommandExitCode, runVerifierRounds } = await import('./run.js')
  const quiet = () => undefined
  const rounds = (...outcomes: VerifierRoundOutcome[]) => (round: number) => Promise.resolve(outcomes[round - 1]!)
  const finishedLater = await runVerifierRounds(3, rounds(
    { left: 1, secondsLeftInEpoch: 86_400, failed: true, enrollmentFailures: new Map() },
    { left: 0, secondsLeftInEpoch: 86_400, failed: false, enrollmentFailures: new Map() },
  ), quiet)
  assert.equal(runCommandExitCode(finishedLater), 0)
  const failedLast = await runVerifierRounds(2, rounds(
    { left: 1, secondsLeftInEpoch: 86_400, failed: false, enrollmentFailures: new Map() },
    { left: 1, secondsLeftInEpoch: 86_400, failed: true, enrollmentFailures: new Map() },
  ), quiet)
  assert.equal(runCommandExitCode(failedLast), 1)
  assert.equal(runCommandExitCode({ failed: false, enrollmentFailures: new Map([['model-a', 'out of credit']]) }), 1)
  assert.equal(runCommandExitCode(null), 0)
})
