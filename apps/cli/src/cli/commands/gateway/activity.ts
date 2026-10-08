import { createWriteStream } from 'node:fs'
import type { Writable } from 'node:stream'
import type { Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import type { RequestLogEntry } from '../../../gateway/console-api/types.js'
import { listAuditEntries } from '../../../gateway/services/audit.js'
import {
  decodeCursor,
  listRequestPage,
  parseGroupBy,
  parseSearch,
  parseStatusFilter,
  parseTime,
  requestCsvChunks,
  requestDetail,
  requestDto,
  usageReport,
} from '../../../gateway/services/usage.js'
import type { GatewayStore, RequestLogFilter, UsageFilter } from '../../../gateway/store.js'
import { parsePositiveInteger } from '../parse-positive-integer.js'
import { addBundleExportOptions, runBundleExport, type BundleExportOptions } from './migrate.js'
import { formatTime, printJson, requireKey, requireMember, requireWorkspace, withGateway } from './shared.js'

interface FilterOptions { workspace?: string; key?: string; member?: string; model?: string; from?: string; to?: string }
interface LogOptions extends FilterOptions { status?: string; search?: string }

function addFilterOptions(cmd: Command): Command {
  return cmd
    .option('--workspace <id|name>', 'only this workspace')
    .option('--key <id>', 'only this API key')
    .option('--member <member>', 'only keys owned by this member (id or email)')
    .option('--model <model>', 'only this model')
    .option('--from <time>', 'from this time (ISO date or epoch ms)')
    .option('--to <time>', 'up to this time (ISO date or epoch ms)')
}

function addLogFilterOptions(cmd: Command): Command {
  return addFilterOptions(cmd)
    .option('--status <status>', 'success, error, or an HTTP status code')
    .option('--search <text>', 'substring of the model, key, end user, tag, seller, path or error')
}

/** The operator sees every key: no `keyIds` scoping. */
function usageFilter(store: GatewayStore, options: FilterOptions): UsageFilter {
  return {
    keyIds: null,
    workspaceId: options.workspace ? requireWorkspace(store, options.workspace).id : null,
    keyId: options.key ? requireKey(store, options.key).id : null,
    memberId: options.member ? requireMember(store, options.member).id : null,
    model: options.model?.trim() || null,
  }
}

function logFilter(store: GatewayStore, options: LogOptions): RequestLogFilter {
  return {
    ...usageFilter(store, options),
    from: parseTime(options.from, 'from'),
    to: parseTime(options.to, 'to'),
    status: parseStatusFilter(options.status),
    q: parseSearch(options.search),
  }
}

function money(value: string | null): string {
  return value === null ? '-' : `$${Number(value).toFixed(4)}`
}

function statusCell(entry: RequestLogEntry): string {
  if (entry.status === null) return chalk.dim('…')
  return entry.status < 400 ? chalk.green(String(entry.status)) : chalk.red(`${entry.status}${entry.errorCode ? ` ${entry.errorCode}` : ''}`)
}

function logLine(entry: RequestLogEntry): string {
  return [
    formatTime(entry.startedAt),
    entry.tag,
    statusCell(entry),
    entry.keyLabel ?? entry.keyId ?? '-',
    entry.model ?? '-',
    entry.sellerPeerId ? entry.sellerPeerId.slice(0, 10) : '-',
    entry.latencyMs === null ? '-' : `${entry.latencyMs}ms`,
    `${entry.inputTokens ?? 0}/${entry.outputTokens ?? 0} tok`,
    money(entry.spent),
  ].join('  ')
}

/**
 * Polls the request log for finished requests not printed yet, until
 * `signal` aborts. Exported for tests.
 */
export async function followRequests(
  store: GatewayStore,
  filter: RequestLogFilter,
  options: { intervalMs: number; signal: AbortSignal; since: number; onEntry: (entry: RequestLogEntry) => void },
): Promise<void> {
  const printed = new Set<string>()
  // In-flight requests can finish after newer ones start: look back a while.
  const lookbackMs = 10 * 60 * 1000
  let since = options.since
  while (!options.signal.aborted) {
    const rows = store.listRequests({ ...filter, from: Math.max(filter.from ?? 0, since - lookbackMs), limit: 1_000 })
      .filter((row) => row.finishedAt !== null && !printed.has(row.tag) && row.startedAt >= options.since)
      .reverse()
    for (const row of rows) {
      printed.add(row.tag)
      since = Math.max(since, row.startedAt)
      options.onEntry(requestDto(row))
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.intervalMs)
      options.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
}

export function registerGatewayActivityCommands(gateway: Command): void {
  addFilterOptions(
    gateway.command('usage')
      .description('Spend, requests and tokens over a period (default: the last 30 days), optionally grouped'),
  )
    .option('--group-by <field>', 'day, model, key, member, peer, workspace or user')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: FilterOptions & { groupBy?: string; json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const report = usageReport(store, usageFilter(store, options), {
        from: parseTime(options.from, 'from'),
        to: parseTime(options.to, 'to'),
        groupBy: parseGroupBy(options.groupBy),
        now: Date.now(),
      })
      if (options.json) {
        printJson(report)
        return
      }
      console.log(`${chalk.bold('Usage')} ${formatTime(report.from)} → ${formatTime(report.to)} UTC`)
      const { totals } = report
      console.log(`Spent ${money(totals.spent)} on ${totals.requests} request(s) (${totals.failedRequests} failed); tokens ${totals.inputTokens} in (${totals.cachedInputTokens} cached), ${totals.outputTokens} out`)
      if (report.groups.length === 0) return
      const table = new Table({ head: [options.groupBy ?? 'Group', 'Requests', 'Failed', 'Spent', 'In tokens', 'Out tokens'] })
      for (const group of report.groups) {
        table.push([group.label, group.requests, group.failedRequests, money(group.spent), group.inputTokens, group.outputTokens])
      }
      console.log(table.toString())
    }))

  const logs = gateway.command('logs').description('The request log: list (default), follow, or show one request')

  addLogFilterOptions(
    logs.command('list', { isDefault: true })
      .description('Recent requests, newest first'),
  )
    .option('--limit <n>', 'rows per page (at most 200)', parsePositiveInteger, 50)
    .option('--before <cursor>', 'the next-page cursor printed by a previous page')
    .option('--follow', 'keep printing new requests as they finish (Ctrl-C stops)', false)
    .option('--interval <ms>', 'poll interval for --follow', parsePositiveInteger, 2_000)
    .option('--json', 'print machine-readable JSON (one object per line with --follow)', false)
    .action((options: LogOptions & { limit: number; before?: string; follow: boolean; interval: number; json: boolean }, cmd: Command) => withGateway(cmd, async ({ store }) => {
      const filter = logFilter(store, options)
      if (options.follow) {
        const controller = new AbortController()
        const stop = (): void => controller.abort()
        process.once('SIGINT', stop)
        try {
          await followRequests(store, filter, {
            intervalMs: options.interval,
            signal: controller.signal,
            since: filter.from ?? Date.now(),
            onEntry: (entry) => console.log(options.json ? JSON.stringify(entry) : logLine(entry)),
          })
        } finally {
          process.off('SIGINT', stop)
        }
        return
      }
      const page = listRequestPage(store, filter, { before: decodeCursor(options.before), limit: options.limit })
      if (options.json) {
        printJson(page)
        return
      }
      if (page.requests.length === 0) {
        console.log(chalk.dim('No requests match.'))
        return
      }
      for (const entry of page.requests) console.log(logLine(entry))
      if (page.nextBefore) console.log(chalk.dim(`More: antseed gateway logs --before ${page.nextBefore}`))
    }))

  logs.command('show')
    .description('One request in full, with its bodies when content logging is on')
    .argument('<tag>', 'request tag (from `gateway logs`)')
    .option('--json', 'print machine-readable JSON', false)
    .action((tag: string, options: { json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const detail = requestDetail(store, tag, null)
      if (options.json) {
        printJson(detail)
        return
      }
      const workspace = detail.workspaceId ? store.getWorkspace(detail.workspaceId)?.name ?? detail.workspaceId : '-'
      console.log(`${chalk.bold(detail.tag)}  ${statusCell(detail)}  ${detail.method} ${detail.path}`)
      console.log(`Started: ${new Date(detail.startedAt).toISOString()}${detail.finishedAt ? `, finished after ${detail.finishedAt - detail.startedAt}ms` : ' (in flight)'}`)
      console.log(`Key: ${detail.keyLabel ?? '-'} (${detail.keyId ?? '-'}), workspace ${workspace}, member ${detail.memberId ?? '-'}, end user ${detail.endUser ?? '-'}`)
      console.log(`Model: ${detail.model ?? '-'}  Seller: ${detail.sellerPeerId ?? '-'}  Latency: ${detail.latencyMs ?? '-'}ms`)
      console.log(`Tokens: ${detail.inputTokens ?? 0} in (${detail.cachedInputTokens ?? 0} cached), ${detail.outputTokens ?? 0} out  Spent: ${money(detail.spent)}`)
      if (detail.errorCode || detail.errorMessage) console.log(chalk.red(`Error: ${detail.errorCode ?? ''} ${detail.errorMessage ?? ''}`.trim()))
      if (detail.requestBody !== null) console.log(`${chalk.bold('Request body:')}\n${detail.requestBody}`)
      if (detail.responseBody !== null) console.log(`${chalk.bold('Response body:')}\n${detail.responseBody}`)
      if (detail.requestBody === null && detail.responseBody === null) console.log(chalk.dim('Bodies are not stored (content logging is off: `antseed gateway settings set-observability --log-content on`).'))
    }))

  addBundleExportOptions(addLogFilterOptions(
    gateway.command('export')
      .description('Export the request log as CSV (the console\'s export; never request or response bodies), or with --out the whole gateway as an encrypted bundle to move it to a server'),
  ))
    .option('--csv', 'CSV format (the only one, and the default)', true)
    .option('--output <file>', 'write to this file instead of stdout')
    .action((options: LogOptions & BundleExportOptions & { output?: string }, cmd: Command) => options.out ? runBundleExport(cmd, options) : withGateway(cmd, async ({ store }) => {
      const filter = logFilter(store, options)
      const out: Writable = options.output ? createWriteStream(options.output, { mode: 0o600 }) : process.stdout
      let rows = -1
      for (const chunk of requestCsvChunks(store, filter)) {
        rows += chunk.split('\r\n').length - 1
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve))
      }
      if (options.output) {
        await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())))
        console.error(chalk.dim(`Wrote ${rows} request(s) to ${options.output}.`))
      }
    }))

  gateway.command('audit')
    .description('The audit log of console and CLI changes, newest first')
    .option('--action <verb>', 'only this action and everything under it, e.g. "key" or "key.create"')
    .option('--actor <id>', 'only changes by this member, key or token id')
    .option('--limit <n>', 'entries per page (at most 500)', parsePositiveInteger, 100)
    .option('--before <cursor>', 'the next-page cursor printed by a previous page')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { action?: string; actor?: string; limit: number; before?: string; json: boolean }, cmd: Command) => withGateway(cmd, ({ store }) => {
      const page = listAuditEntries(store, { before: options.before ?? null, limit: options.limit, actorId: options.actor ?? null, action: options.action ?? null })
      if (options.json) {
        printJson(page)
        return
      }
      if (page.entries.length === 0) {
        console.log(chalk.dim('No audit entries match.'))
        return
      }
      const table = new Table({ head: ['When', 'Actor', 'Action', 'Target', 'Details'], colWidths: [18, 22, 26, 26, 50], wordWrap: true })
      for (const entry of page.entries) {
        table.push([
          formatTime(entry.at),
          `${entry.actor.kind}${entry.actor.label ? ` ${entry.actor.label}` : ''}`,
          entry.action,
          entry.target ? `${entry.target.kind} ${entry.target.label ?? entry.target.id ?? ''}` : '-',
          Object.keys(entry.details).length ? JSON.stringify(entry.details) : '-',
        ])
      }
      console.log(table.toString())
      if (page.nextBefore) console.log(chalk.dim(`More: antseed gateway audit --before ${page.nextBefore}`))
    }))
}
