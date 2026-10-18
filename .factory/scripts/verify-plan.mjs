#!/usr/bin/env node
// Which verify-antseed rows does this change require? Deterministic: the diff against inputs/verify-rows.json,
// the forced keys row for security-critical changes, and each changed package's own test and typecheck.
//   node verify-plan.mjs <slug>     -> runs/<slug>/verify/plan.json
//   node verify-plan.mjs --audit    -> each row's commands must appear verbatim in the skill on the sandbox stack
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FACTORY, SANDBOX_REF, loadState, runDir, sh } from '../lib/common.mjs'

const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$')
const table = JSON.parse(readFileSync(join(FACTORY, 'inputs', 'verify-rows.json'), 'utf8'))

if (process.argv[2] === '--audit') {
  const skill = sh('git', ['-C', FACTORY, 'show', `${SANDBOX_REF}:.claude/skills/verify-antseed/SKILL.md`]).stdout
  const missing = table.rows.flatMap((r) => [...r.unit, ...(r.scratch_build ?? [])].filter((c) => !skill.includes(c)).map((c) => `${r.id}: ${c}`))
  console.log(missing.length ? `VERIFY_ROWS_AUDIT FAIL not in the skill: ${missing.join(' | ')}` : `VERIFY_ROWS_AUDIT OK every row command is in ${SANDBOX_REF}'s verify-antseed table`)
  process.exit(missing.length ? 1 : 0)
}

const slug = process.argv[2]
const rd = runDir(slug)
const { worktree, base } = loadState(slug)
const files = sh('git', ['-C', worktree, 'diff', '--name-only', `${base}..HEAD`]).stdout.split('\n').filter(Boolean)
const security = existsSync(join(rd, 'security.json')) ? JSON.parse(readFileSync(join(rd, 'security.json'), 'utf8')) : { critical: false }

const rows = table.rows.filter((r) => files.some((f) => r.match.some((g) => globRe(g).test(f))) || (r.always_for_security_critical && security.critical))
  .map((r) => ({ id: r.id, why: r.always_for_security_critical && security.critical && !files.some((f) => r.match.some((g) => globRe(g).test(f))) ? 'forced: security-critical change' : `matched: ${files.filter((f) => r.match.some((g) => globRe(g).test(f))).join(', ')}`, proven: r.proven, judgment: r.judgment }))

// Owning packages: the nearest package.json above each changed file.
const owners = new Map()
for (const f of files) {
  for (let d = dirname(f); d && d !== '.'; d = dirname(d)) {
    const pj = join(worktree, d, 'package.json')
    if (existsSync(pj)) { const p = JSON.parse(readFileSync(pj, 'utf8')); owners.set(p.name, p.scripts ?? {}); break }
  }
}
const unit = []
const add = (cmd, why) => { if (!unit.some((u) => u.cmd === cmd)) unit.push({ cmd, why }) }
for (const [name, scripts] of owners) {
  if (scripts.test) add(`pnpm --filter ${name} test`, `owning package ${name}`)
  if (scripts.typecheck) add(`pnpm --filter ${name} run typecheck`, `owning package ${name}`)
}
const picked = table.rows.filter((r) => rows.some((x) => x.id === r.id))
for (const r of picked) for (const c of r.unit) add(c, `row ${r.id}`)
const scenarios = [...new Set(picked.flatMap((r) => r.sandbox))]
const plan = {
  slug, base, head: sh('git', ['-C', worktree, 'rev-parse', 'HEAD']).stdout.trim(), files, security_critical: security.critical,
  rows, unit, build: [...owners.keys()].map((n) => `pnpm --filter ${n} run build`),
  sandbox: scenarios.length ? { scenarios, scratch_build: [...new Set(picked.flatMap((r) => r.scratch_build ?? []))], xvfb: picked.some((r) => r.xvfb) } : null,
}
mkdirSync(join(rd, 'verify'), { recursive: true })
writeFileSync(join(rd, 'verify', 'plan.json'), JSON.stringify(plan, null, 2) + '\n')
console.log(`VERIFY_PLAN ${slug} rows=${rows.map((r) => r.id).join(',') || 'none'} unit=${unit.length} sandbox=${scenarios.join(',') || 'none'}`)
