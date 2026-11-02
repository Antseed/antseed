export type ReferenceProgressPlan = {
  model: string
  contrastModels: readonly string[]
  configurationError?: string
  bankedProbeCount?: number
  skipReason?: string
}

type ReferenceProgressOutput = {
  isTTY?: boolean
  columns?: number
  write: (chunk: string) => unknown
}

type ReferenceProgressState = {
  progress: number
  stage: string
  completed: boolean
}

export function formatReferenceBuildPlan(plans: readonly ReferenceProgressPlan[]): string[] {
  return plans.map((plan) => plan.configurationError
    ? `- ${plan.model}: configuration error: ${plan.configurationError}`
    : plan.skipReason
      ? `- ${plan.model}: skipped (${plan.skipReason}); contrasts ${plan.contrastModels.join(', ') || '(none)'}`
    : `- ${plan.model}: contrasts ${plan.contrastModels.join(', ') || '(none)'}`)
}

export function estimateReferenceBuildProgress(
  message: string,
  contrastModels: readonly string[],
): number {
  const collecting = message.match(/collecting (\d+)\/(\d+) probes/)
  if (collecting) return 0.05 + 0.15 * ratio(collecting[1]!, collecting[2]!)

  if (/testing \d+ new candidates for stability/.test(message)) return 0.25

  const checkingContrast = message.match(/^checking contrast model (.+)$/)
  if (checkingContrast) {
    const index = contrastModels.indexOf(checkingContrast[1]!)
    const position = index >= 0 ? index + 1 : 1
    return 0.35 + 0.3 * position / Math.max(contrastModels.length, 1)
  }

  const selected = message.match(/(\d+)\/(\d+) selected$/)
  if (selected) return 0.68 + 0.04 * ratio(selected[1]!, selected[2]!)

  const selfTesting = message.match(/^self-testing \d+-(\d+) of (\d+) probes$/)
  if (selfTesting) return 0.75 + 0.2 * ratio(selfTesting[1]!, selfTesting[2]!)

  if (/^reference size \d+:/.test(message)) return 0.97
  return 0
}

export class ReferenceBuildProgress {
  readonly interactive: boolean
  private readonly states = new Map<string, ReferenceProgressState>()
  private active = false
  private rendered = false

  constructor(
    private readonly plans: readonly ReferenceProgressPlan[],
    private readonly output: ReferenceProgressOutput = process.stdout,
  ) {
    this.interactive = output.isTTY === true
    for (const plan of plans) {
      this.states.set(plan.model, { progress: 0, stage: 'waiting', completed: false })
    }
  }

  start(): void {
    if (!this.interactive || this.active) return
    this.active = true
    this.render()
  }

  update(model: string, message: string): void {
    if (!this.interactive) return
    const state = this.states.get(model)
    const plan = this.plans.find((candidate) => candidate.model === model)
    if (!state || !plan) return
    state.progress = Math.max(state.progress, estimateReferenceBuildProgress(message, plan.contrastModels))
    state.stage = message
    this.render()
  }

  complete(model: string, message = 'complete'): void {
    if (!this.interactive) return
    const state = this.states.get(model)
    if (!state) return
    state.progress = 1
    state.completed = true
    state.stage = message
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
    const barWidth = 18
    const maximumLength = Math.max(Math.min((this.output.columns ?? 120) - 4, 140), 1)
    for (const plan of this.plans) {
      const state = this.states.get(plan.model)!
      const filled = Math.round(state.progress * barWidth)
      const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`
      const model = plan.model.length > modelWidth
        ? `${plan.model.slice(0, modelWidth - 1)}…`
        : plan.model.padEnd(modelWidth)
      const line = `${model} [${bar}] ${String(Math.round(state.progress * 100)).padStart(3)}% | ${state.stage}`
      this.output.write(`\r\x1b[2K${line.slice(0, maximumLength)}\n`)
    }
    this.rendered = true
  }
}

function ratio(numerator: string, denominator: string): number {
  const total = Number(denominator)
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.min(Math.max(Number(numerator) / total, 0), 1)
}
