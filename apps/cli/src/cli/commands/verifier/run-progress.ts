import type { ModelVerificationTargetResult } from '../../../verifier/model-run.js'
import type { VerificationOutcomeReasonV1 } from '../../../verifier/outcome-reason.js'

export type VerifierRunProgressPlan = {
  model: string
  providerCount: number
  skippedCount?: number
}

type VerifierRunProgressOutput = {
  isTTY?: boolean
  columns?: number
  write: (chunk: string) => unknown
}

type VerifierRunProgressState = {
  same: number
  diff: number
  undetermined: number
  failed: number
  skipped: number
  phase: string
}

export class VerifierRunProgress {
  readonly interactive: boolean
  private readonly states = new Map<string, VerifierRunProgressState>()
  private active = false
  private rendered = false

  constructor(
    private readonly plans: readonly VerifierRunProgressPlan[],
    private readonly output: VerifierRunProgressOutput = process.stdout,
  ) {
    this.interactive = output.isTTY === true
    for (const plan of plans) {
      this.states.set(plan.model, {
        same: 0,
        diff: 0,
        undetermined: 0,
        failed: 0,
        skipped: plan.skippedCount ?? 0,
        phase: 'waiting',
      })
    }
  }

  start(): void {
    if (!this.interactive || this.active) return
    this.active = true
    this.render()
  }

  activate(model: string): void {
    const state = this.states.get(model)
    if (!this.interactive || !state) return
    state.phase = 'running'
    this.render()
  }

  recordVerdict(
    model: string,
    verdict: ModelVerificationTargetResult['status'],
    reason?: VerificationOutcomeReasonV1 | null,
  ): void {
    const state = this.states.get(model)
    if (!this.interactive || !state) return
    if (verdict === 'SAME') state.same += 1
    else if (verdict === 'DIFF') state.diff += 1
    else state.undetermined += 1
    if (reason) state.phase = `${verdict.toLowerCase()}: ${reason.code}`
    this.render()
  }

  recordFailure(model: string, reason?: VerificationOutcomeReasonV1): void {
    const state = this.states.get(model)
    if (!this.interactive || !state) return
    state.failed += 1
    if (reason) state.phase = `failed: ${reason.code}`
    this.render()
  }

  recordSkip(model: string, reason?: VerificationOutcomeReasonV1): void {
    const state = this.states.get(model)
    if (!this.interactive || !state) return
    state.skipped += 1
    if (reason) state.phase = `skipped: ${reason.code}`
    this.render()
  }

  complete(model: string): void {
    const state = this.states.get(model)
    if (!this.interactive || !state) return
    state.phase = 'done'
    this.render()
  }

  finish(): void {
    if (!this.interactive || !this.active) return
    this.render()
    this.active = false
  }

  private render(): void {
    if (!this.active) return
    if (this.rendered) this.output.write(`\x1b[${this.plans.length}A`)
    const modelWidth = Math.min(Math.max(...this.plans.map((plan) => plan.model.length), 5), 30)
    const barWidth = 16
    const maximumLength = Math.max(Math.min((this.output.columns ?? 120) - 4, 140), 1)
    for (const plan of this.plans) {
      const state = this.states.get(plan.model)!
      const completed = state.same + state.diff + state.undetermined + state.failed + state.skipped
      const outstanding = Math.max(plan.providerCount - completed, 0)
      const progress = plan.providerCount === 0 ? 1 : Math.min(completed / plan.providerCount, 1)
      const filled = Math.round(progress * barWidth)
      const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`
      const model = plan.model.length > modelWidth
        ? `${plan.model.slice(0, modelWidth - 1)}…`
        : plan.model.padEnd(modelWidth)
      const line = `${model} [${bar}] ${completed}/${plan.providerCount} OUT:${outstanding} `
        + `SAME:${state.same} DIFF:${state.diff} UNDET:${state.undetermined} `
        + `SKIP:${state.skipped} FAIL:${state.failed} | ${state.phase}`
      this.output.write(`\r\x1b[2K${line.slice(0, maximumLength)}\n`)
    }
    this.rendered = true
  }
}
