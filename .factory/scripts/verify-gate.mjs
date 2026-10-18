#!/usr/bin/env node
// Verify gate: decides from verify.sh's recorded exit codes alone, never from a model's claim.
//   node verify-gate.mjs <slug> <label>  -> runs/<slug>/verify/<label>/gate.json, VERIFY_GATE <slug> PASS|FAIL
// Pass needs: the plan is for the current HEAD; every build and unit command exit 0; for sandbox rows, the
// doctor exit 0 after the fix, every scenario exit 0 after the fix unless it failed identically on the
// baseline without the fix (pre-existing: allowed, reported), and the sandbox torn down.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadState, runDir, sh } from '../lib/common.mjs'

const [slug, label = 'r1'] = process.argv.slice(2)
const out = join(runDir(slug), 'verify', label)
const plan = JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8'))
const rows = readFileSync(join(out, 'results.tsv'), 'utf8').trim().split('\n').filter(Boolean)
  .map((l) => { const [phase, kind, id, exit, secs, cmd, file] = l.split('\t'); return { phase, kind, id, exit: Number(exit), secs: Number(secs), cmd, file } })
const failLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => /\[sandbox\] FAIL /.test(l)).map((l) => l.trim()).sort().join('\n') : '')
const problems = [], notes = []
const head = sh('git', ['-C', loadState(slug).worktree, 'rev-parse', 'HEAD']).stdout.trim()
if (plan.head !== head) problems.push(`results are for ${plan.head.slice(0, 9)}, HEAD is ${head.slice(0, 9)}`)
for (const r of rows.filter((r) => r.phase === 'fix')) if (r.exit !== 0) problems.push(`${r.kind} \`${r.cmd}\` exit ${r.exit}`)
for (const u of plan.unit) if (!rows.some((r) => r.phase === 'fix' && r.cmd === u.cmd)) problems.push(`unit \`${u.cmd}\` never ran`)
const scenarios = []
if (plan.sandbox) {
  const doctor = rows.filter((r) => r.kind === 'doctor' && r.phase === 'after').at(-1)
  if (!doctor) problems.push('doctor never ran after the fix')
  else if (doctor.exit !== 0) problems.push(`doctor exit ${doctor.exit} after the fix (${doctor.file})`)
  for (const after of rows.filter((r) => r.kind === 'scenario' && r.phase === 'after')) {
    const name = after.id.replace(/^after-/, '')
    const before = rows.find((r) => r.kind === 'scenario' && r.phase === 'before' && r.id === `before-${name}`)
    const s = { scenario: name, before: before?.exit ?? null, after: after.exit, verdict: 'pass' }
    if (after.exit !== 0) {
      const same = before && before.exit !== 0 && failLines(before.file) && failLines(before.file) === failLines(after.file)
      s.verdict = same ? 'pre-existing' : 'regression'
      if (same) notes.push(`${name} fails identically without and with the fix (pre-existing): ${failLines(after.file).split('\n')[0]}`)
      else problems.push(`scenario ${name} exit ${after.exit} after the fix${before ? ` (baseline exit ${before.exit})` : ''}: ${failLines(after.file).split('\n')[0] || after.file}`)
    }
    scenarios.push(s)
  }
  if (!scenarios.length) problems.push('no scenario ran after the fix')
  const down = rows.filter((r) => r.kind === 'down').at(-1)
  if (!down || down.exit !== 0) problems.push('the sandbox was not torn down with pnpm sandbox down')
}
const gate = { passed: problems.length === 0, head, rows: plan.rows.map((r) => r.id), security_critical: plan.security_critical, problems, notes, scenarios, results: rows }
writeFileSync(join(out, 'gate.json'), JSON.stringify(gate, null, 2) + '\n')
console.log(`VERIFY_GATE ${slug} ${gate.passed ? 'PASS' : 'FAIL'} rows=${gate.rows.join(',') || 'none'}${problems.length ? ` | ${problems.join(' | ')}` : ''}${notes.length ? ` | notes: ${notes.join(' | ')}` : ''}`)
process.exit(gate.passed ? 0 : 1)
