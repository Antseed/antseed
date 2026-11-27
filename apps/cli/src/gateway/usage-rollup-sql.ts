/**
 * The SQL of the hourly usage rollup (`usage_hourly`, migration 18): what one
 * request-log row and one ledger row add to it. The migration's triggers and
 * the background backfill of older rows (`GatewayStore.backfillUsageRollup`)
 * both build on these, so a row counts the same whichever path rolled it up.
 *
 * Part of a shipped migration: never edit. A change of what the rollup counts
 * is a new migration with new triggers (and a rebuilt rollup).
 *
 * A rollup row is one hour and one attribution (key, workspace, member, model,
 * served model, seller, router, end user; `''` for none, since a primary key
 * can't group NULLs). Requests count in the hour they started, ledger entries
 * in the hour they were recorded, as the reports always read them. Tokens are
 * the ledger's metered tokens plus, for a request with no metered tokens, the
 * tokens its response reported, so they never add up twice.
 */

export const HOUR_MS = 60 * 60 * 1000

/** The rollup's columns after `hour_start`: its primary key, then the totals. */
export const USAGE_DIMENSIONS = ['key_id', 'workspace_id', 'member_id', 'model', 'served_model', 'seller_peer_id', 'router_peer_id', 'end_user'] as const
export const USAGE_TOTALS = [
  'requests', 'failed_requests', 'billed_requests', 'spent_usdc', 'credited_usdc', 'input_tokens', 'cached_input_tokens', 'output_tokens',
] as const

type UsageTotal = (typeof USAGE_TOTALS)[number]

const KEY_COLUMNS = ['hour_start', ...USAGE_DIMENSIONS].join(', ')

/** The hour and attribution of a row of `alias`, a request-log or ledger row, keyed by `time` (its column). */
function dimensions(alias: string, time: string): string[] {
  return [
    `(${alias}.${time} / ${HOUR_MS}) * ${HOUR_MS}`,
    `${alias}.key_id`,
    ...USAGE_DIMENSIONS.slice(1).map((column) => `COALESCE(${alias}.${column}, '')`),
  ]
}

/**
 * `INSERT … SELECT` into the rollup, adding `totals` (missing ones are 0) to
 * the row of `keys`. `tail` (FROM and WHERE) completes the SELECT; its WHERE
 * clause also keeps SQLite from reading the upsert as a join constraint.
 * `grouped` sums many source rows per key (GROUP BY the keys' positions).
 */
function upsert(keys: string[], totals: Partial<Record<UsageTotal, string>>, tail: string, grouped = false): string {
  const values = USAGE_TOTALS.map((column) => totals[column] ?? '0')
  return `
    INSERT INTO usage_hourly (${KEY_COLUMNS}, ${USAGE_TOTALS.join(', ')})
    SELECT ${[...keys, ...values].join(', ')}
    ${tail}
    ${grouped ? `GROUP BY ${keys.map((_, index) => index + 1).join(', ')}` : ''}
    ON CONFLICT (${KEY_COLUMNS}) DO UPDATE SET
      ${USAGE_TOTALS.map((column) => `${column} = ${column} + excluded.${column}`).join(',\n      ')};`
}

const TOKENS = (alias: string) => `${alias}.input_tokens + ${alias}.cached_input_tokens + ${alias}.output_tokens`

/** Whether any spend of request `tag` has been recorded (optionally: other than ledger row `exceptId`). */
function spendExists(tag: string, extra = ''): string {
  return `EXISTS (SELECT 1 FROM ledger_entries t WHERE t.request_tag = ${tag} AND t.kind = 'spend'${extra})`
}

/**
 * What request-log row `alias` adds, with `flags.spent` (it has spend in the
 * ledger) and `flags.reported` (its tokens come from its response: it
 * reported some and its spend carries none). A billed request is one with
 * spend or reported tokens.
 */
function requestTotals(alias: string, flags: string, sign: 1 | -1): Partial<Record<UsageTotal, string>> {
  const s = sign === 1 ? '' : '-'
  return {
    requests: `${s}1`,
    failed_requests: `${s}(CASE WHEN ${alias}.finished_at IS NOT NULL AND (${alias}.status IS NULL OR ${alias}.status >= 400) THEN 1 ELSE 0 END)`,
    billed_requests: `${s}(CASE WHEN ${flags}.spent OR ${flags}.reported THEN 1 ELSE 0 END)`,
    input_tokens: `${s}(${flags}.reported * COALESCE(${alias}.usage_input_tokens, 0))`,
    cached_input_tokens: `${s}(${flags}.reported * COALESCE(${alias}.usage_cached_input_tokens, 0))`,
    output_tokens: `${s}(${flags}.reported * COALESCE(${alias}.usage_output_tokens, 0))`,
  }
}

/** The `spent` and `reported` flags of request-log row `alias`, as columns. */
function requestFlagColumns(alias: string): string {
  return `${spendExists(`${alias}.tag`)} AS spent,
    (${alias}.usage_input_tokens IS NOT NULL AND NOT ${spendExists(`${alias}.tag`, ` AND ${TOKENS('t')} > 0`)}) AS reported`
}

/** A one-row subquery `q` with the flags of a trigger's `OLD` or `NEW` row. */
function requestFlags(alias: 'OLD' | 'NEW'): string {
  return `(SELECT ${requestFlagColumns(alias)}) q`
}

/**
 * What ledger row `alias` adds. A spend that names no request this log has
 * (none, or one pruned before it arrived) counts as a billed request of its
 * own, once per request tag.
 */
function ledgerTotals(alias: string, sign: 1 | -1): Partial<Record<UsageTotal, string>> {
  const s = sign === 1 ? '' : '-'
  const spend = (value: string) => `${s}(CASE WHEN ${alias}.kind = 'spend' THEN ${value} ELSE 0 END)`
  return {
    billed_requests: `${s}(CASE WHEN ${alias}.kind = 'spend' AND (${alias}.request_tag IS NULL OR (
      NOT EXISTS (SELECT 1 FROM gateway_requests r WHERE r.tag = ${alias}.request_tag)
      AND NOT ${spendExists(`${alias}.request_tag`, ` AND t.id < ${alias}.id`)})) THEN 1 ELSE 0 END)`,
    spent_usdc: spend(`-${alias}.amount_usdc`),
    credited_usdc: `${s}(CASE WHEN ${alias}.kind = 'credit' THEN ${alias}.amount_usdc ELSE 0 END)`,
    input_tokens: spend(`${alias}.input_tokens`),
    cached_input_tokens: spend(`${alias}.cached_input_tokens`),
    output_tokens: spend(`${alias}.output_tokens`),
  }
}

/**
 * Rows the triggers keep: requests started from `requests_from` on (or before
 * the backfill's cursor, once it has rolled them up), ledger rows above
 * `ledger_from` (or at most its cursor). The rest wait for the backfill, which
 * reads them as they are then, so no row is counted twice or left out.
 */
const requestKept = (alias: string) =>
  `EXISTS (SELECT 1 FROM usage_rollup_state s WHERE ${alias}.started_at >= s.requests_from OR ${alias}.started_at < s.requests_cursor)`
const ledgerKept = (alias: string) =>
  `EXISTS (SELECT 1 FROM usage_rollup_state s WHERE ${alias}.id > s.ledger_from OR ${alias}.id <= s.ledger_cursor)`

const REQUEST_CHANGED = [
  ...USAGE_DIMENSIONS, 'started_at', 'status', 'finished_at', 'usage_input_tokens', 'usage_cached_input_tokens', 'usage_output_tokens',
].map((column) => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')
const LEDGER_CHANGED = [...USAGE_DIMENSIONS, 'created_at', 'kind', 'amount_usdc', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'request_tag']
  .map((column) => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')

/** Migration 18: the rollup, its triggers and the backfill's state. */
export function usageRollupMigrationSql(): string {
  return `
  CREATE TABLE usage_hourly (
    hour_start INTEGER NOT NULL,
    ${USAGE_DIMENSIONS.map((column) => `${column} TEXT NOT NULL`).join(',\n    ')},
    ${USAGE_TOTALS.map((column) => `${column} INTEGER NOT NULL DEFAULT 0`).join(',\n    ')},
    PRIMARY KEY (${KEY_COLUMNS})
  ) WITHOUT ROWID;
  CREATE INDEX usage_hourly_key ON usage_hourly(key_id, hour_start);
  CREATE INDEX usage_hourly_workspace ON usage_hourly(workspace_id, hour_start);
  CREATE TABLE usage_rollup_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    requests_from INTEGER NOT NULL,
    requests_cursor INTEGER NOT NULL,
    ledger_from INTEGER NOT NULL,
    ledger_cursor INTEGER NOT NULL,
    requests_pruned_before INTEGER NOT NULL
  );
  INSERT INTO usage_rollup_state (id, requests_from, requests_cursor, ledger_from, ledger_cursor, requests_pruned_before)
  SELECT 1, f.requests_from, COALESCE((SELECT MIN(started_at) FROM gateway_requests), f.requests_from), COALESCE((SELECT MAX(id) FROM ledger_entries), 0), 0,
    COALESCE((SELECT MAX(hour_start) FROM request_rollups) + ${HOUR_MS}, 0)
  FROM (SELECT MAX(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), COALESCE((SELECT MAX(started_at) FROM gateway_requests), 0) + 1) AS requests_from) f;
  ${upsert(
    ['u.hour_start', 'u.key_id', ...['workspace_id', 'member_id', 'model'].map((c) => `COALESCE(u.${c}, '')`), "''", ...['seller_peer_id', 'router_peer_id', 'end_user'].map((c) => `COALESCE(u.${c}, '')`)],
    { requests: 'SUM(u.requests)', failed_requests: 'SUM(u.failed_requests)' },
    'FROM request_rollups u WHERE true',
    true,
  )}
  CREATE TRIGGER usage_hourly_request_insert AFTER INSERT ON gateway_requests WHEN ${requestKept('NEW')} BEGIN
    ${upsert(dimensions('NEW', 'started_at'), requestTotals('NEW', 'q', 1), `FROM ${requestFlags('NEW')} WHERE true`)}
  END;
  CREATE TRIGGER usage_hourly_request_update AFTER UPDATE ON gateway_requests WHEN (${REQUEST_CHANGED}) AND ${requestKept('OLD')} BEGIN
    ${upsert(dimensions('OLD', 'started_at'), requestTotals('OLD', 'q', -1), `FROM ${requestFlags('OLD')} WHERE true`)}
    ${upsert(dimensions('NEW', 'started_at'), requestTotals('NEW', 'q', 1), `FROM ${requestFlags('NEW')} WHERE true`)}
  END;
  CREATE TRIGGER usage_hourly_ledger_insert AFTER INSERT ON ledger_entries WHEN ${ledgerKept('NEW')} BEGIN
    ${upsert(dimensions('NEW', 'created_at'), ledgerTotals('NEW', 1), 'WHERE true')}
    ${usageRollupFirstSpendSql()}
  END;
  CREATE TRIGGER usage_hourly_ledger_update AFTER UPDATE ON ledger_entries WHEN (${LEDGER_CHANGED}) AND ${ledgerKept('OLD')} BEGIN
    ${upsert(dimensions('OLD', 'created_at'), ledgerTotals('OLD', -1), 'WHERE true')}
    ${upsert(dimensions('NEW', 'created_at'), ledgerTotals('NEW', 1), 'WHERE true')}
  END;
  `
}

/**
 * A new spend can change what its request adds: the first spend makes a
 * request without reported tokens billed, and the first spend with tokens
 * replaces the tokens its response reported. Only for a request the rollup
 * already counts (one the backfill has yet to reach is read with this spend).
 */
function usageRollupFirstSpendSql(): string {
  const firstSpend = `NOT ${spendExists('NEW.request_tag', ' AND t.id <> NEW.id')}`
  const replacesReported = `(${TOKENS('NEW')} > 0 AND r.usage_input_tokens IS NOT NULL
    AND NOT ${spendExists('NEW.request_tag', ` AND t.id <> NEW.id AND ${TOKENS('t')} > 0`)})`
  const billed = `(${firstSpend} AND r.usage_input_tokens IS NULL)`
  const replaced = (column: string) => `-(CASE WHEN ${replacesReported} THEN COALESCE(r.${column}, 0) ELSE 0 END)`
  return upsert(
    dimensions('r', 'started_at'),
    {
      billed_requests: `CASE WHEN ${billed} THEN 1 ELSE 0 END`,
      input_tokens: replaced('usage_input_tokens'),
      cached_input_tokens: replaced('usage_cached_input_tokens'),
      output_tokens: replaced('usage_output_tokens'),
    },
    `FROM gateway_requests r WHERE NEW.kind = 'spend' AND r.tag = NEW.request_tag AND (${replacesReported} OR ${billed}) AND ${requestKept('r')}`,
  )
}

/**
 * The backfill of request-log rows started in `[?, ?)`, grouped into the
 * rollup. Each row's flags are read once (a materialized CTE keeps SQLite from
 * repeating their lookups in every total that uses them).
 */
export function usageRollupRequestBackfillSql(): string {
  const summed = Object.fromEntries(Object.entries(requestTotals('b', 'b', 1))
    .map(([column, value]) => [column, column === 'requests' ? 'COUNT(*)' : `SUM(${value})`]))
  const columns = ['tag', 'started_at', 'finished_at', 'status', 'usage_input_tokens', 'usage_cached_input_tokens', 'usage_output_tokens', ...USAGE_DIMENSIONS]
  return `WITH b AS MATERIALIZED (
      SELECT ${columns.map((column) => `r.${column}`).join(', ')}, ${requestFlagColumns('r')}
      FROM gateway_requests r WHERE r.started_at >= ? AND r.started_at < ?
    )
    ${upsert(dimensions('b', 'started_at'), summed, 'FROM b WHERE true', true)}`
}

/** The backfill of ledger rows with ids in `(?, ?]`, grouped into the rollup. */
export function usageRollupLedgerBackfillSql(): string {
  const summed = Object.fromEntries(Object.entries(ledgerTotals('b', 1)).map(([column, value]) => [column, `SUM(${value})`]))
  return upsert(dimensions('b', 'created_at'), summed, 'FROM ledger_entries b WHERE b.id > ? AND b.id <= ?', true)
}
