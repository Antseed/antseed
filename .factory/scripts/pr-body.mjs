#!/usr/bin/env node
// The draft PR body, written for a human reviewer: short, verbatim where it matters, no machine paths and no
// references to factory-internal files. Usage: node pr-body.mjs <slug>  (prints the body; publish.sh checks it)
//   1 issue link (or "no issue: task-file run")   2 test level + test file   3 key red lines verbatim + green summary
//   4 the fix in one or two sentences   5 verify rows pass/fail (pre-existing named)   6 one line per reviewer + verdict
//   7 security-critical marker naming only the matched glob and files    + one collapsed <details> with full evidence
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadState, runDir, sh } from '../lib/common.mjs'

const slug = process.argv[2]
const rd = runDir(slug)
const S = loadState(slug)
const read = (f) => (existsSync(join(rd, f)) ? readFileSync(join(rd, f), 'utf8') : '')
const plan = read('test-plan.md')
const section = (h) => (plan.split(`\n## ${h}\n`)[1] ?? '').split('\n## ')[0].trim()
const code = (h) => section(h).match(/`([^`]+)`/)?.[1] ?? ''
// Anything that still looks like a machine path is cut down to what a reviewer can use.
const clean = (s) => s.replace(/(?:\/(?:root|tmp|home)|~)\/\S*?\/reports\/([^/\s]+)\/report\.json/g, 'report $1')
  .replace(/\S*\/(?:root|tmp|home)\/\S*\/\.factory\/scripts\/sandbox-scratch\.sh \S+ down/g, 'pnpm sandbox down')
  .replace(/(?:\/(?:root|tmp|home)|~)\/[^\s`'")]*/g, '<local path>')
const git = (...a) => sh('git', ['-C', S.worktree, ...a]).stdout.trim()
const commits = git('rev-list', '--reverse', `${S.base}..HEAD`).split('\n').filter(Boolean)
const subject = (c) => git('log', '--format=%h %s', '-1', c)
const out = []
const p = (...lines) => out.push(...lines)

// 7 + 1: security marker and issue line first, where a reviewer looks.
const security = JSON.parse(read('security.json') || '{"critical":false}')
if (security.critical) {
  const byGlob = {}
  for (const { file, glob } of security.paths) (byGlob[glob] ??= []).push(file)
  const parts = Object.entries(byGlob).map(([glob, files]) => `${files.map((f) => `\`${f}\``).join(', ')} (security-critical glob \`${glob}\`)`)
  for (const m of security.markers) parts.push(`a changed line matching \`/${m.regex}/\``)
  p(security.pr_flag.body_marker, `> **Security-critical:** this change touches ${parts.join('; ')}. The verify-antseed "keys, signing or spend caps" row ran.`, '')
}
p(S.issue ? `Refs #${S.issue}` : 'No GitHub issue: this is a task-file run (a self-chosen smoke bug).', '')

// 4: the fix, from the fix commit's own explanation.
const fixBody = git('log', '--format=%b', '-1', commits[1]).split('\n\n')[0].replace(/\s+/g, ' ').trim()
// Deliberate scope from the run's scope note (runs/<slug>/scope.json); every listed path must exist at HEAD.
const scope = JSON.parse(read('scope.json') || '{}')
const unchanged = scope.left_unchanged ?? []
for (const u of unchanged) if (sh('git', ['-C', S.worktree, 'cat-file', '-e', `HEAD:${u.path}`]).status !== 0) throw new Error(`scope.json lists ${u.path}, which does not exist at HEAD`)
const list = unchanged.map((u) => `\`${u.path}\``)
const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0]
p('## Fix', '', fixBody + (unchanged.length ? ` Deliberately left unchanged (${scope.decided_by}'s scope decision: ${scope.decision}): ${joined}. ${scope.reason}` : ''), '')

// 2 + 3: test level, test file, the red that matters, the green summary.
const red = read('evidence/red-fresh.txt').split('\n')
const green = read('evidence/green.txt').split('\n')
const fails = []
red.forEach((l, i) => { if (/^ FAIL /.test(l)) fails.push([l.trim(), ...red.slice(i + 1, i + 8).filter((x) => /^(Expected|Received):/.test(x))]) })
const redSummary = red.find((l) => /^\s+Tests\s+\d+ failed/.test(l))?.trim() ?? ''
const greenSummary = green.find((l) => /^\s+Tests\s+\d+ passed/.test(l))?.trim() ?? ''
const level = section('Proof').split('\n')[0].trim()
p('## Test', '', `${level === 'unit' ? 'Unit test' : level}: \`${code('Test file')}\`, run with \`${code('Test command')}\`.`, '',
  `Red at commit 1 (\`${subject(commits[0])}\`) on origin/main ${S.base.slice(0, 9)}, in a fresh checkout:`, '', '```')
const sig = code('Red signature')
const key = fails.find((f) => f.some((l) => l.includes(sig))) ?? fails[0]
p(...(key ?? []).map(clean), redSummary, '```', '', `Green at commit 2 (\`${subject(commits[1])}\`): \`${greenSummary}\`.`, '')

// 5: verify rows and scenarios.
const vdir = `verify/${S.last_verify}`
const gate = JSON.parse(read(`${vdir}/gate.json`) || '{}')
const vplan = JSON.parse(read(`${vdir}/plan.json`) || '{}')
const fixRows = (gate.results ?? []).filter((r) => r.phase === 'fix' && r.kind === 'unit')
p('## Verification (verify-antseed)', '')
// Each row's verdict comes from its own commands (verify-plan records which row asked for each command).
const verdict = (cmds) => { const rs = cmds.map((c) => fixRows.find((r) => r.cmd === c)); return rs.length && rs.every((r) => r && r.exit === 0) ? 'pass' : 'FAIL' }
const cmdsFor = (why) => (vplan.unit ?? []).filter((u) => u.why === why).map((u) => u.cmd)
for (const row of vplan.rows ?? []) {
  const forced = row.why.startsWith('forced')
  const cmds = cmdsFor(`row ${row.id}`)
  p(`- **${row.id}**${forced ? ' (forced: security-critical change)' : ''}: ${cmds.length} unit command${cmds.length === 1 ? '' : 's'}, ${verdict(cmds)}`)
}
for (const owner of [...new Set((vplan.unit ?? []).filter((u) => u.why.startsWith('owning package ')).map((u) => u.why.slice(15)))]) {
  p(`- owning package \`${owner}\` test and typecheck: ${verdict(cmdsFor(`owning package ${owner}`))}`)
}
for (const s of gate.scenarios ?? []) p(`- sandbox \`${s.scenario}\` (--chain local): ${s.verdict === 'pass' ? 'PASS' : s.verdict === 'pre-existing' ? 'fails identically without and with this change (pre-existing, not caused by it)' : 'FAIL'}`)
p('')

// 6: review, one line per reviewer for the final round, the judge, earlier rounds in one line each.
const models = ['claude-opus-5.5', 'claude-fable-5.1', 'gpt-6-astra']
const labels = { 'claude-opus-5.5': 'A', 'claude-fable-5.1': 'B', 'gpt-6-astra': 'C' }
const firstFinding = (txt) => (txt.match(/^### 1\.\s*\[[^\]]*\]\s*(.+)$/m)?.[1] ?? '').replace(/`/g, '').trim().replace(/\.$/, '')
const titles = (txt, heading) => ((txt.split(`### ${heading}`)[1] ?? '').split('\n### ')[0].match(/^\d+\. \*\*(.+?)\*\*/gm) ?? []).map((t) => t.replace(/^\d+\. \*\*|\*\*$/g, '').replace(/`/g, '').replace(/\.$/, ''))
const rounds = Number(S.review_round ?? 1)
p('## Review', '', `Three independent read-only reviews, each a separate Claude Code session on its own model, then a lead judgment (claude-opus-5.5). ${rounds} round${rounds > 1 ? 's' : ''}.`, '')
for (let r = 1; r < rounds; r += 1) {
  const j = read(`judgment-r${r}.md`)
  const counts = models.map((m) => `${labels[m]} ${read(`review-r${r}-${m}.md`).match(/(\d+) findings\s*$/)?.[1] ?? '?'}`).join(', ')
  const acts = titles(j, 'Act On')
  p(`- Round ${r}: findings ${counts}. Judge: ${acts.length} to act on${acts.length ? `, fixed before round ${r + 1}: ${acts.join('; ')}` : ''}.`)
}
for (const m of models) {
  const txt = read(`review-r${rounds}-${m}.md`)
  const n = txt.match(/(\d+) findings\s*$/)?.[1] ?? '?'
  p(`- Round ${rounds}, ${labels[m]} (${m}): ${n} finding${n === '1' ? '' : 's'}${n !== '0' && firstFinding(txt) ? `: ${firstFinding(txt)}` : ''}.`)
}
const jfinal = read(S.last_judge)
const consider = titles(jfinal, 'Consider')
p(`- Judge (round ${rounds}): \`${(jfinal.match(/^JUDGE .*$/m)?.[0] ?? '').trim()}\`.${consider.length ? ` Left to consider: ${consider.join('; ')}.` : ''}`, '')

// One collapsed block with the full evidence, still without paths.
const blast = read('blast-radius.md')
const fact = ((blast.split('## The one fact')[1] ?? '').split('\n## ')[0].match(/\*\*(.+?)\*\*/)?.[1] ?? '').trim()
p('<details><summary>Full evidence</summary>', '', 'All red assertions (commit 1, fresh checkout):', '', '```')
for (const f of fails) p(...f.map(clean))
p(redSummary, '```', '', 'Verification commands (fix branch, and a local sandbox checkout that adds these two commits to the sandbox stack; never pushed):', '', '| Where | Command | Exit |', '| --- | --- | --- |')
const where = { before: 'sandbox, without this change', after: 'sandbox, with this change', fix: 'fix branch' }
for (const r of gate.results ?? []) p(`| ${where[r.phase] ?? r.phase} | \`${clean(r.cmd).replace(/\|/g, '\\|')}\` | ${r.exit} |`)
for (const s of gate.scenarios ?? []) {
  const lines = read(`${vdir}/after-${s.scenario}.txt`).split('\n').filter((l) => /\[sandbox\] (PASS|FAIL|KNOWN|Error)\b/.test(l)).map((l) => clean(l.trim()))
  p('', `\`${s.scenario}\` with this change (without it: exit ${s.before}, with it: exit ${s.after}):`, '', '```', ...lines, '```')
}
if (fact) p('', `Blast radius, the one fact the change is safe because of: ${clean(fact.replace(/`/g, ''))}`)
p('', '</details>', '', '---', 'Draft opened by the local Claude factory (every step a pinned Claude Code session via the AntSeed peer GesundAI, every gate a script). Needs a human review before it is marked ready.')
console.log(out.join('\n'))
