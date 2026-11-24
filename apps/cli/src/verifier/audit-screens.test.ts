import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { ConcurrencyLimiter, type AuditTaskLimiter } from './audit-concurrency.js'
import { METHODS } from './methods/index.js'
import type { MethodEnv, MethodRun } from './audit-method.js'
import { testsOfRun, type MethodSwitches } from './audit-screens.js'
import { FLIPS_RULE } from './methods/flips/flips-score.js'
import { referenceFixture } from './model-audit-fixtures.test-support.js'
import { createReferenceRequestLimiter, type ReferenceRequestLimiter } from './model-reference.js'
import { OUTPUT_ECHO_RULE } from './methods/output-echo/output-echo.js'
import type { ReferenceOracle } from './reference-oracle.js'
import type { ResponseAuthReader } from './response-auth-reader.js'
import { TOKENIZER_PRECHECK_RULE } from './methods/tokens/tokenizer-precheck.js'

// FLIPS counts for the first and is recorded only for the second, which the eval never measured.
const COUNTED = 'deepseek-v4-pro'
const PLAIN = 'model-b'
const EPOCH = '7'

/** What a run hands its tests, with everything they do with it written down. */
interface Run {
  run: MethodRun
  epochDir: string
  warned: string[]
  auditorAsked: number
  ownReference: ReferenceRequestLimiter[]
  ownSeller: AuditTaskLimiter[]
}

async function withRun(body: (run: Run) => Promise<void>): Promise<void> {
  const epochDir = await mkdtemp(join(tmpdir(), 'antseed-audit-screens-'))
  const made: Run = {
    epochDir, warned: [], auditorAsked: 0, ownReference: [], ownSeller: [],
    run: {
      epoch: EPOCH,
      epochDir,
      runId: 'run-1',
      auditor: async () => {
        made.auditorAsked += 1
        return '0x1111111111111111111111111111111111111111'
      },
      ownLimiters: {
        reference: () => {
          const limiter = createReferenceRequestLimiter(undefined)
          made.ownReference.push(limiter)
          return limiter
        },
        seller: () => {
          const limiter = new ConcurrencyLimiter(4)
          made.ownSeller.push(limiter)
          return limiter
        },
      },
      warn: (line) => { made.warned.push(line) },
    },
  }
  try {
    await body(made)
  } finally {
    await rm(epochDir, { recursive: true, force: true })
  }
}

interface Asked {
  kind: 'inputTokens' | 'replies'
  bank: KbfReferenceV1
  contents?: readonly string[]
  bodies?: readonly Record<string, unknown>[]
  maxTokens?: number
  limiter: ReferenceRequestLimiter
  signal?: AbortSignal
}

/** What a run hands a model's tests. The reference answers nothing: every request of it fails. */
function envFor(model: string) {
  const asked: Asked[] = []
  const reported: Array<[string, unknown]> = []
  const files: Array<[string, unknown]> = []
  const warned: string[] = []
  const noted: string[] = []
  const shared = createReferenceRequestLimiter(undefined)
  const questions = new ConcurrencyLimiter(4)
  let crowdListed = 0
  const failed = { upstream: { name: 'referenceEndpoint' } as never, oneProvider: true }
  const reference: ReferenceOracle = {
    inputTokens: async (bank, contents, options) => {
      asked.push({ kind: 'inputTokens', bank, contents, maxTokens: options.maxTokens, limiter: options.limiter, signal: options.signal })
      return { ...failed, results: contents.map(() => ({ inputTokens: null, cachedInput: false, provider: null, failure: 'the reference is down' })) }
    },
    replies: async (bank, asks, options) => {
      asked.push({ kind: 'replies', bank, ...asks, limiter: options.limiter, signal: options.signal })
      const count = 'bodies' in asks ? asks.bodies.length : asks.contents.length
      return {
        ...failed, provenOneProvider: true,
        results: Array.from({ length: count }, () => ({
          requestBody: new Uint8Array(), askedBody: new Uint8Array(), response: null, provider: null, failure: 'the reference is down', tries: 3, rateLimited: 0,
        })),
      }
    },
  }
  const env: MethodEnv = {
    model,
    get sellers() {
      crowdListed += 1
      return [{ peerId: 'a1'.repeat(20), service: model }, { peerId: 'b2'.repeat(20), service: model }]
    },
    seller: {
      proxyBaseUrl: 'http://127.0.0.1:1',
      responseAuthReader: { waitForVerified: async () => { throw new Error('no seller is asked here') }, close() {} } as ResponseAuthReader,
      limiter: questions,
      requestTimeoutMs: 1_000,
    },
    reference,
    limiters: { reference: shared },
    report: {
      reference: (check, record) => { reported.push([check, record]) },
      file: async (name, content) => { files.push([name, structuredClone(content)]) },
      warn: (line) => { warned.push(line) },
      note: (line) => { noted.push(line) },
    },
  }
  return { env, asked, reported, files, warned, noted, shared, crowdListed: () => crowdListed }
}

/** Runs `body` with these environment variables set, and puts back what was there. */
async function withEnvironment(values: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  try {
    await body()
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))
const bank = referenceFixture(PLAIN)

test('every test has a switch of the config, and the list is the order its screens are built in', () => {
  assert.deepEqual(METHODS.map((check) => [check.slot, check.toggle.key]), [
    ['tokenizerPrecheck', 'tokenizerPrecheck'], ['outputCap', 'outputChecks'], ['outputEcho', 'outputChecks'], ['flips', 'flips'],
  ])
})

test('a run gives a model the screen of every test, in the list\'s order, and none of a test switched off', async () => {
  const cases: Array<[MethodSwitches | undefined, string[]]> = [
    [undefined, ['tokenizerPrecheck', 'outputCap', 'outputEcho', 'flips']],
    [{ tokenizerPrecheck: true, outputChecks: true, flips: true }, ['tokenizerPrecheck', 'outputCap', 'outputEcho', 'flips']],
    [{ tokenizerPrecheck: false }, ['outputCap', 'outputEcho', 'flips']],
    [{ outputChecks: false }, ['tokenizerPrecheck', 'flips']],
    [{ flips: false }, ['tokenizerPrecheck', 'outputCap', 'outputEcho']],
    [{ tokenizerPrecheck: false, outputChecks: false, flips: false }, []],
  ]
  for (const [switches, slots] of cases) {
    await withRun(async ({ run }) => {
      const screens = (await testsOfRun(run, switches))(envFor(PLAIN).env)
      assert.deepEqual(Object.keys(screens), slots, JSON.stringify(switches))
      await settled()
    })
  }
})

test('a test\'s work for the whole run is done once, before any model, and not at all when it is switched off', async () => {
  await withRun(async (made) => {
    const screensOf = await testsOfRun(made.run, undefined)
    // FLIPS's key is made, readable by its owner only, with its own seller limiter and the auditor's address; its
    // reference limiter is each model's own, so no model's reference waits behind another's.
    const key = join(made.epochDir, 'flips-master.key')
    assert.match((await readFile(key, 'utf8')).trim(), /^[0-9a-f]{64}$/)
    assert.equal((await stat(key)).mode & 0o077, 0)
    assert.deepEqual([made.ownReference.length, made.ownSeller.length, made.auditorAsked], [0, 1, 1])
    screensOf(envFor(PLAIN).env)
    screensOf(envFor(COUNTED).env)
    assert.deepEqual([made.ownReference.length, made.ownSeller.length, made.auditorAsked], [2, 1, 1], 'a model makes only its own reference limiter')
    assert.notEqual(made.ownReference[0], made.ownReference[1])
    assert.deepEqual(made.warned, [])
    await settled()
  })
  await withRun(async (made) => {
    const screensOf = await testsOfRun(made.run, { flips: false })
    screensOf(envFor(PLAIN).env)
    await assert.rejects(stat(join(made.epochDir, 'flips-master.key')), /ENOENT/)
    assert.deepEqual([made.ownReference.length, made.ownSeller.length, made.auditorAsked], [0, 0, 0])
  })
})

test('the crowd is listed once for each test that asks for it, and not at all when none does', async () => {
  await withRun(async ({ run }) => {
    const all = envFor(PLAIN)
    ;(await testsOfRun(run, undefined))(all.env)
    assert.equal(all.crowdListed(), 2, 'the pre-check and the echo check each list it')
    const none = envFor(PLAIN)
    ;(await testsOfRun(run, { tokenizerPrecheck: false, outputChecks: false }))(none.env)
    assert.equal(none.crowdListed(), 0)
    await settled()
  })
})

test('the pre-check, the cap check and the echo check ask the reference in the run\'s shared limiter; FLIPS asks in its own', async () => {
  await withRun(async (made) => {
    const model = envFor(PLAIN)
    const screens = (await testsOfRun(made.run, undefined))(model.env)

    await screens.tokenizerPrecheck!.ready(bank)
    const precheck = model.asked.splice(0)
    assert.ok(precheck.length > 0)
    for (const ask of precheck) {
      assert.deepEqual([ask.kind, ask.bank, ask.maxTokens, ask.limiter], ['inputTokens', bank, TOKENIZER_PRECHECK_RULE.maxTokens, model.shared])
      assert.ok(ask.signal instanceof AbortSignal)
    }
    assert.deepEqual(model.warned, [`${PLAIN}: the tokenizer pre-check has no reference this run (the reference is down); its sellers are judged on the questions alone`])

    // The cap check first asks the model's own reply to one capped request: its prompt, under the limit drawn.
    await screens.outputCap!.ready(bank)
    const [capReply, ...capRest] = model.asked.splice(0)
    assert.deepEqual(capRest, [])
    assert.deepEqual([capReply!.kind, capReply!.bank, capReply!.contents!.length, capReply!.limiter], ['replies', bank, 1, model.shared])
    assert.ok(Number.isInteger(capReply!.maxTokens) && capReply!.maxTokens! > 0)
    assert.equal(capReply!.bodies, undefined)

    await screens.outputEcho!.ready(bank)
    const echo = model.asked.splice(0)
    assert.ok(echo.length > 0)
    for (const ask of echo) {
      assert.deepEqual([ask.kind, ask.bank, ask.maxTokens, ask.limiter], ['replies', bank, OUTPUT_ECHO_RULE.maxTokens, model.shared])
      assert.ok(ask.contents!.every((content) => content.startsWith('Repeat the text below exactly')))
    }
    // Each reference record is written beside the model's audits under its test's name.
    assert.deepEqual(model.reported.map(([check]) => check), ['output-cap', 'output-echo'])
    assert.deepEqual(model.reported.map(([, record]) => (record as { applies: boolean }).applies), [false, false])

    // FLIPS: whole bodies, in the reference limiter FLIPS made for this model.
    screens.flips!.warm!(PLAIN, bank, 'first')
    await settled()
    const flips = model.asked.splice(0)
    assert.ok(flips.length > 0)
    for (const ask of flips) {
      assert.deepEqual([ask.kind, ask.bank, ask.contents, ask.maxTokens, ask.limiter], ['replies', bank, undefined, undefined, made.ownReference.at(-1)])
      assert.ok(ask.bodies!.length > 0 && ask.signal instanceof AbortSignal)
    }
    assert.notEqual(made.ownReference.at(-1), model.shared)
  })
})

test('FLIPS keeps a status file beside the model\'s audits, and says above the run\'s progress why a stage has no result', async () => {
  await withRun(async (made) => {
    const model = envFor(PLAIN)
    const screens = (await testsOfRun(made.run, undefined))(model.env)
    await settled()
    assert.deepEqual(model.files, [['flips-status.json', { version: 1, kind: 'antseed-verifier-flips-status', model: PLAIN, unavailable: [] }]])
    screens.flips!.warm!(PLAIN, bank, 'first')
    await settled()
    const [[name, status]] = model.files.slice(-1) as [[string, { unavailable: Array<{ stage: string; code: string; detail: string }> }]]
    assert.equal(name, 'flips-status.json')
    assert.deepEqual(status.unavailable.map((event) => [event.stage, event.code]), [['first', 'reference-failed']])
    assert.deepEqual(model.warned, [`FLIPS ${PLAIN} first: no result (reference-failed): ${status.unavailable[0]!.detail}`])
    assert.deepEqual(made.warned, [], 'a line about a model goes above the progress, not to the run\'s own lines')
  })
})

test('a FLIPS key others can read: no FLIPS screen for any model, said once for the run and stored with each model', async () => {
  await withRun(async (made) => {
    const key = join(made.epochDir, 'flips-master.key')
    await writeFile(key, `${'ab'.repeat(32)}\n`)
    await chmod(key, 0o644)
    const screensOf = await testsOfRun(made.run, undefined)
    assert.equal(made.warned.length, 1)
    assert.match(made.warned[0]!, /^FLIPS: no randomness check this run: the FLIPS key .*flips-master\.key is readable by others \(mode 644\)/)
    for (const name of [PLAIN, COUNTED]) {
      const model = envFor(name)
      assert.deepEqual(Object.keys(screensOf(model.env)), ['tokenizerPrecheck', 'outputCap', 'outputEcho'])
      await settled()
      assert.deepEqual(model.files, [['flips-status.json', {
        version: 1, kind: 'antseed-verifier-flips-status', model: name, keyFailed: made.warned[0]!.replace('FLIPS: no randomness check this run: ', ''), unavailable: [],
      }]])
    }
    assert.equal(made.warned.length, 1)
  })
})

test('the FLIPS dry-run probe is read once for the run, refused where FLIPS counts, and a value that cannot be read is no probe', async () => {
  const probe = { stage: 'confirm' as const }
  await withEnvironment({ ANTSEED_VERIFIER_FLIPS_PROBE: JSON.stringify(probe) }, () => withRun(async (made) => {
    const screensOf = await testsOfRun(made.run, undefined)
    assert.deepEqual(made.warned, [`FLIPS: dry-run probe on (${JSON.stringify(probe)}): every FLIPS record is a diagnostic`])
    const plain = envFor(PLAIN)
    const probed = screensOf(plain.env).flips!
    assert.deepEqual([probed.probing, probed.probeSettings, probed.ruleId], [true, JSON.stringify(probe), FLIPS_RULE.id])
    const counted = envFor(COUNTED)
    const production = screensOf(counted.env).flips!
    // Where FLIPS counts the probe is refused: the run's own line, and a production FLIPS.
    assert.deepEqual([production.probing, production.probeSettings], [false, null])
    assert.deepEqual(made.warned.slice(1), [`FLIPS: probe refused for ${COUNTED}: FLIPS counts for it`])
    assert.deepEqual([plain.warned, counted.warned], [[], []])
    await settled()
    // The status file names the probe only where it runs.
    assert.deepEqual(plain.files[0]![1], { version: 1, kind: 'antseed-verifier-flips-status', model: PLAIN, probe, unavailable: [] })
    assert.deepEqual(counted.files[0]![1], { version: 1, kind: 'antseed-verifier-flips-status', model: COUNTED, unavailable: [] })
  }))
  await withEnvironment({ ANTSEED_VERIFIER_FLIPS_PROBE: '{nope' }, () => withRun(async (made) => {
    const screens = (await testsOfRun(made.run, undefined))(envFor(PLAIN).env)
    assert.deepEqual(made.warned, ['FLIPS: probe ignored: ANTSEED_VERIFIER_FLIPS_PROBE is not JSON'])
    assert.equal(screens.flips!.probing, false)
    await settled()
  }))
  // With FLIPS switched off the probe is not read at all.
  await withEnvironment({ ANTSEED_VERIFIER_FLIPS_PROBE: '{nope' }, () => withRun(async (made) => {
    ;(await testsOfRun(made.run, { flips: false }))(envFor(PLAIN).env)
    assert.deepEqual(made.warned, [])
  }))
})

test('the cap check\'s dry-pass switch is said for every model, also with the output checks switched off', async () => {
  const line = (model: string): string => `${model}: ANTSEED_VERIFIER_CAP_MEASURE_WITHIN is on: the cap check also measures answers that kept to the limit (a dry pass's diagnostic; it costs reference requests and changes no result)`
  await withEnvironment({ ANTSEED_VERIFIER_CAP_MEASURE_WITHIN: '1' }, () => withRun(async ({ run }) => {
    for (const switches of [undefined, { outputChecks: false }]) {
      const screensOf = await testsOfRun(run, switches)
      for (const name of [PLAIN, COUNTED]) {
        const model = envFor(name)
        screensOf(model.env)
        assert.deepEqual(model.noted, [line(name)], JSON.stringify(switches))
        assert.deepEqual(model.warned, [])
      }
    }
    await settled()
  }))
  await withEnvironment({ ANTSEED_VERIFIER_CAP_MEASURE_WITHIN: '0' }, () => withRun(async ({ run }) => {
    const model = envFor(PLAIN)
    ;(await testsOfRun(run, undefined))(model.env)
    assert.deepEqual(model.noted, [])
    await settled()
  }))
})
