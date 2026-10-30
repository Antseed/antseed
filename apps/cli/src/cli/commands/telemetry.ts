import type { Command } from 'commander'
import chalk from 'chalk'
import { getGlobalOptions } from './types.js'
import {
  TELEMETRY_DOCS_URL,
  readConfiguredTelemetry,
  resolveCliConsent,
  writeConfiguredTelemetry,
} from '../../telemetry/settings.js'

const REASON_TEXT: Record<string, string> = {
  do_not_track: 'off: DO_NOT_TRACK is set',
  env_disabled: 'off: ANTSEED_TELEMETRY turns it off',
  ci: 'off: running in CI',
  not_configured: 'off: this build has no telemetry project (source builds send nothing)',
  user_disabled: 'off: turned off with `antseed telemetry disable`',
  dev_build: 'off: development build',
}

export type TelemetryStatusReport = {
  enabled: boolean
  reason: string | null
  configured: boolean | null
  docs: string
}

export function telemetryStatus(configPath: string, env: NodeJS.ProcessEnv = process.env): TelemetryStatusReport {
  const decision = resolveCliConsent(configPath, env)
  const configured = readConfiguredTelemetry(configPath)
  return {
    enabled: decision.enabled,
    reason: decision.enabled ? null : decision.reason,
    configured: configured ?? null,
    docs: TELEMETRY_DOCS_URL,
  }
}

/**
 * `antseed telemetry enable|disable|status`. The choice is `telemetry.enabled`
 * in the config file, which a running buyer (a gateway's included) picks up
 * without a restart, as does the gateway's setup funnel. Only the buyer and the
 * gateway send telemetry; other commands send nothing.
 */
export function registerTelemetryCommands(program: Command): void {
  const telemetry = program
    .command('telemetry')
    .description(`Anonymous buyer and gateway usage data: what is sent and how to turn it off (${TELEMETRY_DOCS_URL})`)

  telemetry
    .command('status')
    .description('Show whether anonymous usage data is sent, and why')
    .option('--json', 'print JSON')
    .action((options: { json?: boolean }) => {
      const report = telemetryStatus(getGlobalOptions(program).config)
      if (options.json) {
        console.log(JSON.stringify(report, null, 2))
        return
      }
      console.log(report.enabled ? chalk.green('Telemetry: on') : `Telemetry: ${REASON_TEXT[report.reason ?? ''] ?? 'off'}`)
      console.log(chalk.dim(`What is sent: ${report.docs}`))
    })

  telemetry
    .command('enable')
    .description('Send anonymous usage data (the default)')
    .action(async () => {
      const { config } = getGlobalOptions(program)
      try {
        await writeConfiguredTelemetry(config, true)
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`))
        process.exitCode = 1
        return
      }
      const report = telemetryStatus(config)
      console.log(report.enabled
        ? chalk.green('Telemetry enabled.')
        : `Telemetry enabled in the config, but still ${REASON_TEXT[report.reason ?? ''] ?? 'off'}.`)
    })

  telemetry
    .command('disable')
    .description('Stop sending anonymous usage data')
    .action(async () => {
      const { config } = getGlobalOptions(program)
      try {
        await writeConfiguredTelemetry(config, false)
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`))
        process.exitCode = 1
        return
      }
      console.log('Telemetry disabled. A running buyer stops sending within a second.')
    })
}
