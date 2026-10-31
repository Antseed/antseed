import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeTextAtomic } from './atomic-files.js'
import {
  epochDirectory,
  escapeHtml,
  type ModelAuditSummaryV1,
  type VerifierRunManifestV1,
} from './audit-artifacts.js'
import { finalAuditVerdict } from './diff-recheck.js'
import { explainInconclusive, explainSkipReason, type PlainReason } from './plain-reason.js'
import { normalized } from './utils.js'

/**
 * One page per epoch that shows every seller × audited model the auditor touched, merged across all
 * of the epoch's runs: green SAME, red DIFF (confirmed by a recheck), yellow UNDETERMINED and grey
 * "tried, not submitted". Hovering a grey or yellow dot says why, in the same words AntScan uses.
 */
export type OverviewCellState = 'same' | 'diff' | 'undetermined' | 'skipped'

export interface OverviewCell {
  state: OverviewCellState
  model: string
  service: string
  runId: string
  /** Matching answers on the first check, 0–1, when the seller answered any. */
  correctRate: number | null
  answered: number | null
  asked: number | null
  recheck: { status: string; correctRate: number | null } | null
  /** Plain-language reason for grey and yellow cells. */
  reason: PlainReason | null
  /** How many runs this epoch produced a verdict for this cell. */
  audits: number
}

export interface OverviewSeller {
  key: string
  label: string
  agentId: string | null
  peerId: string
  cells: Map<string, OverviewCell>
}

export interface EpochOverview {
  epoch: string
  runIds: string[]
  models: string[]
  sellers: OverviewSeller[]
}

export function epochOverviewPath(evidenceDir: string, epoch: string): string {
  return join(epochDirectory(evidenceDir, epoch), 'overview.html')
}

/** Completed runs of an epoch, oldest first, which is the order they are submitted in. */
export async function epochRunManifests(evidenceDir: string, epoch: string): Promise<VerifierRunManifestV1[]> {
  const runsDir = join(evidenceDir, 'runs')
  let names: string[]
  try {
    names = await readdir(runsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const manifests: VerifierRunManifestV1[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.summary.json')) continue
    try {
      const parsed = JSON.parse(await readFile(join(runsDir, name), 'utf8')) as VerifierRunManifestV1
      if (parsed.kind === 'antseed-verifier-run-manifest' && parsed.epoch === epoch) manifests.push(parsed)
    } catch {
      // A manifest being written or a foreign file: leave it out of the overview.
    }
  }
  return manifests.sort((left, right) => left.completedAt.localeCompare(right.completedAt))
}

/**
 * Merges the epoch's runs in submit order. A later verdict replaces an earlier one, as on the
 * contract; a skip only fills a cell that has no verdict, since a skip is never submitted.
 */
export async function buildEpochOverview(
  evidenceDir: string,
  epoch: string,
  manifests?: VerifierRunManifestV1[],
): Promise<EpochOverview> {
  const runs = manifests ?? await epochRunManifests(evidenceDir, epoch)
  const sellers = new Map<string, OverviewSeller>()
  const models: string[] = []
  const sellerFor = (entry: { agentId: string | null; peerId: string; displayName?: string | null }): OverviewSeller => {
    const key = entry.agentId ? `agent:${entry.agentId}` : `peer:${normalized(entry.peerId)}`
    let seller = sellers.get(key)
    if (!seller) {
      seller = { key, label: '', agentId: entry.agentId, peerId: entry.peerId, cells: new Map() }
      sellers.set(key, seller)
    }
    if (entry.displayName) seller.label = entry.displayName
    if (!seller.label) seller.label = entry.agentId ? `agent ${entry.agentId}` : `${entry.peerId.slice(0, 12)}…`
    return seller
  }
  const addModel = (model: string): void => {
    if (!models.includes(model)) models.push(model)
  }

  for (const manifest of runs) {
    for (const entry of manifest.models) {
      let summary: ModelAuditSummaryV1
      try {
        summary = JSON.parse(await readFile(entry.summaryPath, 'utf8')) as ModelAuditSummaryV1
      } catch {
        continue
      }
      const model = summary.model
      addModel(model)
      for (const result of summary.results ?? []) {
        const seller = sellerFor(result)
        const previous = seller.cells.get(model)
        const verdict = finalAuditVerdict(result)
        const recheck = result.recheck
          ? {
            status: result.recheck.status,
            correctRate: result.recheck.parsedProbeCount > 0
              ? result.recheck.correctProbeCount / result.recheck.parsedProbeCount
              : null,
          }
          : null
        const base = {
          model,
          service: result.service,
          runId: manifest.runId,
          correctRate: result.correctRate,
          answered: result.parsedProbeCount,
          asked: result.probeCount,
          recheck,
        }
        if (verdict === null) {
          // A first DIFF that was never rechecked is not submitted; keep any earlier verdict.
          if (previous && previous.state !== 'skipped') continue
          seller.cells.set(model, {
            ...base,
            state: 'skipped',
            reason: explainSkipReason('DIFF not confirmed: no recheck on fresh probes', model),
            audits: previous?.audits ?? 0,
          })
          continue
        }
        const state = verdict === 'SAME' ? 'same' : verdict === 'DIFF' ? 'diff' : 'undetermined'
        seller.cells.set(model, {
          ...base,
          state,
          reason: state === 'undetermined'
            ? explainInconclusive({
              code: result.outcomeReason?.code ?? null,
              summary: result.outcomeReason?.summary ?? null,
              recheckVerdict: result.recheck?.status ?? null,
              answered: result.parsedProbeCount,
              asked: result.probeCount,
            })
            : null,
          audits: (previous?.audits ?? 0) + 1,
        })
      }
      const tried = [
        ...(summary.skipped ?? []).map((skip) => ({ ...skip, text: skip.reason })),
        ...(summary.failures ?? []).map((failure) => ({
          ...failure, displayName: failure.displayName ?? null, text: failure.reason,
        })),
      ]
      for (const skip of tried) {
        const seller = sellerFor(skip)
        const previous = seller.cells.get(model)
        if (previous && previous.state !== 'skipped') continue
        seller.cells.set(model, {
          state: 'skipped',
          model,
          service: skip.service,
          runId: manifest.runId,
          correctRate: null,
          answered: null,
          asked: null,
          recheck: null,
          reason: explainSkipReason(skip.text, model),
          audits: 0,
        })
      }
    }
  }

  const ordered = [...sellers.values()].filter((seller) => seller.cells.size > 0).sort((left, right) => {
    const count = (seller: OverviewSeller, state: OverviewCellState): number =>
      [...seller.cells.values()].filter((cell) => cell.state === state).length
    return count(right, 'diff') - count(left, 'diff')
      || count(right, 'same') - count(left, 'same')
      || left.label.localeCompare(right.label)
  })
  return { epoch, runIds: runs.map((run) => run.runId), models, sellers: ordered }
}

/** Writes `epochs/<epoch>/overview.html`; `runIds` limits it to those runs (default: every run of the epoch). */
export async function writeEpochOverview(evidenceDir: string, epoch: string, runIds?: string[]): Promise<string | null> {
  let manifests = await epochRunManifests(evidenceDir, epoch)
  if (runIds && runIds.length > 0) {
    const wanted = runIds.map(normalized)
    const unknown = wanted.filter((id) => !manifests.some((manifest) => normalized(manifest.runId).startsWith(id)))
    if (unknown.length > 0) throw new Error(`no completed epoch ${epoch} run matches: ${unknown.join(', ')}`)
    manifests = manifests.filter((manifest) => wanted.some((id) => normalized(manifest.runId).startsWith(id)))
  }
  const overview = await buildEpochOverview(evidenceDir, epoch, manifests)
  if (overview.runIds.length === 0) return null
  const path = epochOverviewPath(evidenceDir, epoch)
  await writeTextAtomic(path, renderEpochOverview(overview))
  return path
}

const STATE_LABEL: Record<OverviewCellState, string> = {
  same: 'Verified (SAME)',
  diff: 'Wrong model (DIFF twice)',
  undetermined: 'Inconclusive',
  skipped: 'Tried, not submitted',
}

function percent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

function cellDetail(cell: OverviewCell): string[] {
  const lines: string[] = []
  if (cell.state !== 'skipped' || cell.answered !== null) {
    lines.push(`1st check: ${percent(cell.correctRate)} match (${cell.answered ?? 0} of ${cell.asked ?? 0} answered)`)
  }
  if (cell.recheck) lines.push(`recheck: ${cell.recheck.status}, ${percent(cell.recheck.correctRate)} match`)
  if (cell.state === 'diff') lines.push('DIFF on both checks')
  return lines
}

export function renderEpochOverview(overview: EpochOverview): string {
  const all = overview.sellers.flatMap((seller) => [...seller.cells.values()])
  const count = (state: OverviewCellState): number => all.filter((cell) => cell.state === state).length
  const sellersWith = (state: OverviewCellState): number =>
    overview.sellers.filter((seller) => [...seller.cells.values()].some((cell) => cell.state === state)).length
  const verifiedSellers = overview.sellers.filter((seller) => isVerified(seller)).length
  const audited = overview.sellers.filter((seller) => [...seller.cells.values()].some((cell) => cell.state !== 'skipped')).length
  const notConfirmed = all.filter((cell) => cell.state === 'undetermined' && cell.recheck).length

  const header = overview.models.map((model) => `<th class="m">${escapeHtml(model)}</th>`).join('')
  const rows = overview.sellers.map((seller) => {
    const cells = [...seller.cells.values()]
    const tally = (state: OverviewCellState): number => cells.filter((cell) => cell.state === state).length
    const columns = overview.models.map((model) => {
      const cell = seller.cells.get(model)
      return cell ? `<td>${renderCell(cell)}</td>` : '<td></td>'
    }).join('')
    const name = `${seller.label} ${seller.agentId ?? ''} ${seller.peerId}`.toLowerCase()
    const sub = seller.agentId ? `agent ${seller.agentId}` : `${seller.peerId.slice(0, 12)}…`
    return `<tr data-diff="${tally('diff')}" data-ver="${isVerified(seller) ? 1 : 0}" data-name="${escapeHtml(name)}">`
      + `<th>${escapeHtml(seller.label)}<small>${escapeHtml(sub)}</small></th>`
      + `<td class="num"><b class="tg">${tally('same')}</b> <b class="tr">${tally('diff')}</b> <b class="ty">${tally('undetermined')}</b></td>`
      + `${columns}</tr>`
  }).join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KBF audits · epoch ${escapeHtml(overview.epoch)}</title>
<style>
body{margin:0;background:#1f2023;color:#e6e6e6;font:14px -apple-system,system-ui,sans-serif}
main{padding:20px 28px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#9a9a9a;margin-bottom:16px}
.cards{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid #333;border-radius:14px;overflow:hidden;margin-bottom:16px}
.card{padding:14px 18px;border-right:1px solid #333}.card:last-child{border:0}
.card h3{margin:0;font-size:11px;letter-spacing:.12em;color:#aaa}.card .v{font-size:28px;font-weight:700;margin:6px 0 2px}.card small{color:#888}
.box{border:1px solid #333;border-radius:14px;overflow:auto}
.legend{display:flex;gap:18px;align-items:center;padding:14px 18px;flex-wrap:wrap;color:#ccc;font-weight:600;font-size:13px}
.filters{display:flex;gap:8px;padding:0 18px 12px;align-items:center}
.filters button{background:#2a2b2f;color:#ccc;border:1px solid #444;border-radius:20px;padding:6px 14px;cursor:pointer;font-weight:600}
.filters button.on{background:#22342a;border-color:#3f8f5c;color:#7fd99a}
.filters input{margin-left:auto;background:#1b1c1f;border:1px solid #444;border-radius:8px;color:#ddd;padding:7px 12px;width:240px}
table{border-collapse:collapse;width:100%}
thead th{position:sticky;top:0;z-index:2;background:#26272b;color:#5fbf7d;font-size:11px;letter-spacing:.06em;text-transform:uppercase;padding:12px 6px;border-bottom:1px solid #333;white-space:nowrap}
tbody th{text-align:left;padding:10px 14px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;font-size:12.5px;white-space:nowrap}
tbody th small{display:block;font-weight:400;color:#777;text-transform:none;letter-spacing:0;font-size:11px}
tbody tr{border-bottom:1px solid #2c2c2f}tbody tr:hover{background:#26272b}
td{text-align:center;padding:6px 4px}td.num{white-space:nowrap;font-size:12px}
.tg{color:#5cc26d}.tr{color:#e0524a}.ty{color:#e2b33c}
.cell{position:relative;display:inline-block}
.dot{display:inline-block;width:17px;height:17px;border-radius:50%;vertical-align:middle;cursor:help}
.same{background:#5cb85c}.diff{background:#e0524a}.undetermined{background:#e2b33c}.skipped{background:#d8d8d8}
.cell sup{font-size:9px;color:#aaa;position:absolute;left:19px;top:-2px}
.card-tip{display:none;position:absolute;z-index:5;left:50%;top:24px;transform:translateX(-50%);width:280px;padding:10px 12px;border:1px solid #444;border-radius:10px;background:#2a2b2f;box-shadow:0 8px 24px rgba(0,0,0,.45);text-align:left;font-size:12.5px;line-height:1.4;white-space:normal}
.cell:hover .card-tip,.cell:focus .card-tip{display:block}
.card-tip b{display:block;color:#fff;margin-bottom:4px}.card-tip span{display:block;color:#ccc}.card-tip i{display:block;margin-top:6px;color:#888;font-style:normal;font-size:11.5px}
</style>
</head>
<body>
<main>
<h1>KBF audits · epoch ${escapeHtml(overview.epoch)}</h1>
<div class="sub">${overview.runIds.length} run${overview.runIds.length === 1 ? '' : 's'} merged in submit order (a later verdict replaces an earlier one, as on the contract). A DIFF counts only when a recheck on fresh questions is DIFF too. Hover a dot for details.</div>
<div class="cards">
<div class="card"><h3>AUDITED SELLERS</h3><div class="v">${audited}</div><small>${verifiedSellers} with SAME and no DIFF</small></div>
<div class="card"><h3>SAME</h3><div class="v">${count('same')}</div><small>services verified</small></div>
<div class="card"><h3>DIFF (2× CONFIRMED)</h3><div class="v">${count('diff')}</div><small>${sellersWith('diff')} sellers with ≥1 DIFF</small></div>
<div class="card"><h3>UNDETERMINED</h3><div class="v">${count('undetermined')}</div><small>incl. ${notConfirmed} DIFFs not confirmed</small></div>
<div class="card"><h3>NOT SUBMITTED</h3><div class="v">${count('skipped')}</div><small>tried, not audited or not confirmed</small></div>
</div>
<div class="box">
<div class="legend">${(Object.keys(STATE_LABEL) as OverviewCellState[]).map((state) => `<span><span class="dot ${state}"></span> ${STATE_LABEL[state]}</span>`).join('')}<span style="color:#888;font-weight:400">blank = not offered · hover a grey or yellow dot for the reason</span></div>
<div class="filters"><button class="on" data-f="all">All ${overview.sellers.length}</button><button data-f="ver">Verified ${verifiedSellers}</button><button data-f="diff">Has DIFF ${sellersWith('diff')}</button><input id="q" placeholder="Seller or agent ID"></div>
<table><thead><tr><th style="text-align:left;padding-left:14px">Seller</th><th>S · D · U</th>${header}</tr></thead>
<tbody>
${rows}
</tbody></table>
</div>
</main>
<script>
let f='all';const q=document.getElementById('q');
function apply(){const s=q.value.toLowerCase();document.querySelectorAll('tbody tr').forEach(r=>{const ok=(f=='all'||(f=='ver'&&r.dataset.ver=='1')||(f=='diff'&&r.dataset.diff!='0'))&&r.dataset.name.includes(s);r.style.display=ok?'':'none'})}
document.querySelectorAll('.filters button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.filters button').forEach(x=>x.classList.remove('on'));b.classList.add('on');f=b.dataset.f;apply()});q.oninput=apply;
</script>
</body>
</html>
`
}

function isVerified(seller: OverviewSeller): boolean {
  const cells = [...seller.cells.values()]
  return cells.some((cell) => cell.state === 'same') && !cells.some((cell) => cell.state === 'diff')
}

function renderCell(cell: OverviewCell): string {
  const headline = cell.reason?.headline ?? STATE_LABEL[cell.state]
  const lines = [
    cell.reason ? `<span>${escapeHtml(cell.reason.detail)}</span>` : '',
    ...cellDetail(cell).map((line) => `<span>${escapeHtml(line)}</span>`),
  ].join('')
  const meta = `${cell.model} · service ${cell.service} · run ${cell.runId.slice(0, 10)}…`
    + (cell.audits > 1 ? ` · ${cell.audits} audits` : '')
  const sup = cell.state === 'diff' ? '<sup>2×</sup>' : cell.audits > 1 ? `<sup>${cell.audits}</sup>` : ''
  return `<span class="cell" tabindex="0" aria-label="${escapeHtml(`${headline}. ${cell.reason?.detail ?? ''}`)}">`
    + `<span class="dot ${cell.state}"></span>${sup}`
    + `<span class="card-tip" role="tooltip"><b>${escapeHtml(headline)}</b>${lines}<i>${escapeHtml(meta)}</i></span></span>`
}

