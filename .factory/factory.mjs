#!/usr/bin/env node
// The factory driver. Deterministic: it sequences the stages, runs the script gates, and never decides
// anything a model should judge. Every judgment step is a fresh pinned Claude Code session in its own Herdr
// pane (scripts/native-step.mjs). Run it inside Herdr.
//
//   node .factory/factory.mjs run --slug <slug> (--issue <n> | --task-file <file>) [--note-file <file>] [--from <stage>] [--until <stage>]
//   node .factory/factory.mjs status --slug <slug>
//
// Stages: intake red fix verify blast-radius review no-comments publish reflect. Publish is always a dry run
// unless --publish is given AND FACTORY_ALLOW_PUBLISH=1 (never in this round). Reflect runs at the end of
// every run, also a failed or paused one.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AUDIT_LOG, FACTORY, MODELS, PSTACK, SANDBOX_REF, SKILLS, WT_ROOT, decide, event, herdr, lastLine, loadState, needsInput, read, runDir, saveState, sh } from './lib/common.mjs'

const STAGES = ['intake', 'red', 'fix', 'verify', 'blast-radius', 'review', 'no-comments', 'publish', 'reflect']
const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback }
const slug = opt('slug')
if (!slug) { console.error('usage: factory.mjs run|status --slug <slug> ...'); process.exit(2) }
const RD = runDir(slug)
mkdirSync(RD, { recursive: true })
const script = (name, args, opts = {}) => {
  const r = sh(join(FACTORY, 'scripts', name), args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  writeFileSync(join(RD, 'logs', `${name}-${Date.now()}.log`), r.out)
  return r
}
mkdirSync(join(RD, 'logs'), { recursive: true })

if (cmd === 'status') {
  const s = loadState(slug)
  console.log(JSON.stringify({ ...s, events: read(join(RD, 'events.jsonl')).trim().split('\n').slice(-8).map((l) => JSON.parse(l)) }, null, 2))
  process.exit(0)
}
if (cmd !== 'run') { console.error(`unknown command ${cmd}`); process.exit(2) }
if (process.env.HERDR_ENV !== '1') { console.error('run inside a Herdr pane (sessions are launched in Herdr panes)'); process.exit(2) }

const from = STAGES.indexOf(opt('from', 'intake')), until = STAGES.indexOf(opt('until', 'reflect'))
if (from < 0 || until < 0) { console.error(`stages: ${STAGES.join(' ')}`); process.exit(2) }
const wants = (stage) => STAGES.indexOf(stage) >= from && STAGES.indexOf(stage) <= until
let S = loadState(slug)

// ---------- Herdr layout: one tab per run; its root pane follows the event log ----------
function ensureTab() {
  const tab = S.tab && herdr(['tab', 'get', S.tab])
  if (tab?.tab) return
  const created = herdr(['tab', 'create', '--workspace', process.env.HERDR_WORKSPACE_ID, '--cwd', FACTORY, '--label', `factory ${slug}`, '--no-focus'])
  if (!created?.root_pane) throw new Error('could not create the run tab')
  S = saveState(slug, { tab: created.tab.tab_id, root_pane: created.root_pane.pane_id })
  sh('herdr', ['pane', 'rename', S.root_pane, `factory ${slug} · events`])
  sh('herdr', ['pane', 'run', S.root_pane, `touch ${join(RD, 'events.jsonl')} && tail -n 50 -F ${join(RD, 'events.jsonl')}`])
}
function newPane(cwd, anchor = S.root_pane, direction = 'right') {
  const r = herdr(['pane', 'split', anchor, '--direction', direction, '--cwd', cwd, '--no-focus'])
  if (!r?.pane?.pane_id) throw new Error(`could not split pane ${anchor}`)
  return r.pane.pane_id
}
function reviewTab(round) {
  const t = herdr(['tab', 'create', '--workspace', process.env.HERDR_WORKSPACE_ID, '--cwd', S.worktree, '--label', `factory ${slug} review r${round}`, '--no-focus'])
  if (!t?.root_pane) throw new Error('could not create the review tab')
  return t.root_pane.pane_id
}

// ---------- one judgment step = one fresh pinned session ----------
function vars(extra = {}) {
  const issue = S.issue ? `#${S.issue} (read only)` : 'none (task file)'
  return {
    slug, skills: SKILLS, pstack: PSTACK, factory: FACTORY, run_dir: RD, worktree: S.worktree ?? '(not created yet)', base: S.base ?? '', branch: S.branch ?? '',
    issue, sandbox_ref: SANDBOX_REF, scratch: `${WT_ROOT}/scratch-${slug}`, refs_line: S.issue ? `, and ends with the line \`Refs #${S.issue}\`` : '',
    verify_skill: join(FACTORY, '..', '.claude/skills/verify-antseed/SKILL.md'), sandbox_test_skill: join(FACTORY, '..', '.claude/skills/sandbox-test/SKILL.md'),
    sent_back: '', verify_dir: join(RD, 'verify', S.last_verify ?? 'r1'), ...extra,
  }
}
function render(template, v) {
  const text = read(join(FACTORY, 'prompts', '_preamble.md')) + read(join(FACTORY, 'prompts', template))
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m))
}
// Read-only stages start in a scratch directory under the run dir, with the fix worktree added by path, so
// a relative slip (a persisting `cd`, an unmatched glob) cannot land in the tree they must not touch.
const scratchCwd = (stage) => { const d = join(RD, 'scratch', stage); mkdirSync(d, { recursive: true }); return d }
function runStep({ stage, round = 1, template, prefix, cwd, pane, model, mode, extra = {}, addDirs = [], suffix = '', readonly = false, writeRoot }) {
  if (readonly) { addDirs = [...addDirs, cwd]; cwd = scratchCwd(stage) }
  else writeRoot ??= cwd
  const conf = MODELS.stages[stage] ?? MODELS.stages[template.replace('.md', '')]
  model ??= conf.model
  mode ??= conf.mode
  const tag = `${slug}/${stage}${suffix}-r${round}.${Date.now().toString(36)}`
  const v = vars({ stage, round, model, tag, ...extra })
  mkdirSync(join(RD, 'prompts'), { recursive: true })
  const promptFile = join(RD, 'prompts', `${stage}${suffix}-r${round}.md`)
  writeFileSync(promptFile, render(template, v))
  const out = join(RD, 'sessions', `${stage}${suffix}-r${round}.out.md`)
  pane ??= newPane(cwd)
  const args = [join(FACTORY, 'scripts', 'native-step.mjs'), '--slug', slug, '--stage', stage, '--tag', tag, '--model', model, '--mode', mode,
    '--pane', pane, '--cwd', cwd, '--prompt', promptFile, '--answer-prefix', prefix, '--out', out, '--effort', conf.effort,
    '--timeout-min', String(conf.timeout_min), '--stall-min', String(MODELS.stall_min),
    ...[SKILLS, PSTACK, FACTORY, ...addDirs].flatMap((d) => ['--add-dir', d]), ...(writeRoot ? ['--write-root', writeRoot] : [])]
  event(slug, `${stage}${suffix} r${round}`, 'start', `${model} (${mode}) in pane ${pane}, tag ${tag}`)
  return new Promise((done) => {
    const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', (d) => { log += d; process.stdout.write(d) })
    child.stderr.on('data', (d) => { log += d; process.stderr.write(d) })
    child.on('close', (code) => {
      const answer = log.split('\n').filter((l) => l.startsWith('ANSWER ')).at(-1)?.slice(7) ?? `${prefix} NO_ANSWER`
      event(slug, `${stage}${suffix} r${round}`, code === 0 ? 'answered' : `exit ${code}`, answer)
      decide(slug, stage, `${stage}${suffix} r${round} session (${model}) answered: ${answer}`, 'fresh pinned session, judged by its answer line and the gate after it', out, code === 0 ? 'answered' : `native-step exit ${code}`)
      done({ code, answer, out, tag })
    })
  })
}

// ---------- gates ----------
const snapshot = () => (S.worktree ? `${sh('git', ['-C', S.worktree, 'rev-parse', 'HEAD']).stdout.trim()}\n${sh('git', ['-C', S.worktree, 'status', '--porcelain']).stdout}` : '')
function readOnly(before, who) {
  if (snapshot() !== before) return stop('FAILED', `${who} changed the fix worktree although it is read-only for that step`)
  return true
}
function tripwire(after) {
  if (!S.branch) return
  const remote = sh('git', ['-C', FACTORY, 'ls-remote', 'origin', `refs/heads/${S.branch}`]).stdout.trim()
  const prs = sh('gh', ['pr', 'list', '--head', S.branch, '--state', 'all', '--json', 'number', '--jq', 'length'], { cwd: FACTORY }).stdout.trim()
  if (remote || prs !== '0') stop('FAILED', `tripwire after ${after}: branch on the remote or a PR exists (remote ${remote || 'none'}, PRs ${prs})`)
}
function auditGate(step) {
  if (step.code === 5) stop('FAILED', `${step.tag} stopped at a Claude Code permission prompt (refused with Escape); screen in sessions/*-permission-prompt.txt`)
  if (step.code === 2) stop('FAILED', `audit: ${step.tag} had a request that was not its model on GesundAI; see sessions/*-audit.json`)
}
function intakeCheck() {
  const plan = join(RD, 'test-plan.md')
  if (!existsSync(plan)) return 'test-plan.md missing'
  const text = read(plan)
  if (!text.startsWith('Status: final')) return 'first line is not `Status: final`'
  const heads = ['Task', 'Sharpened', 'Reproduction', 'Root cause', 'Proof', 'Owning package', 'Test file', 'Test command', 'Red signature', 'Expected behavior', 'Out of scope']
  const missing = heads.filter((h) => !text.includes(`\n## ${h}\n`))
  if (missing.length) return `missing sections: ${missing.join(', ')}`
  const sec = (h) => (text.split(`\n## ${h}\n`)[1] ?? '').split('\n## ')[0]
  if (!/`[^`]+`/.test(sec('Test command'))) return 'Test command has no backticked command'
  if (!/`[^`]+`/.test(sec('Red signature'))) return 'Red signature has no backticked text'
  if (!/^\s*(unit|sandbox: \S+)/.test(sec('Proof'))) return 'Proof does not start with `unit` or `sandbox: <scenario>`'
  return ''
}

let outcome = { verdict: 'RUNNING', reason: '' }
class Stop extends Error {}
function stop(verdict, reason) {
  outcome = { verdict, reason }
  decide(slug, 'outcome', `${verdict}: ${reason}`, 'the driver stopped the run at a gate', 'events.jsonl', verdict)
  event(slug, 'outcome', verdict, reason)
  throw new Stop(reason)
}
function pause(stage, question, context) {
  const file = needsInput(slug, stage, question, context)
  decide(slug, stage, `paused: ${question}`, 'genuinely the human\'s call or a finding; the blocked part stops, the rest keeps going', file, 'NEEDS INPUT')
  stop('PAUSED', `NEEDS INPUT (${stage}): ${question} -> ${file}`)
}

// ---------- stages ----------
async function intake() {
  if (!existsSync(join(RD, 'task.md'))) {
    const src = opt('issue') ? ['--issue', opt('issue')] : ['--task-file', opt('task-file')]
    if (opt('note-file')) src.push('--note-file', opt('note-file'))
    const r = script('intake.sh', [slug, ...src]); process.stdout.write(r.out)
    if (r.status) stop('FAILED', `intake.sh: ${lastLine(r.out)}`)
  }
  S = loadState(slug)
  const pre = script('preflight.sh', [slug]); process.stdout.write(pre.out)
  event(slug, 'preflight', pre.status ? 'FAIL' : 'ok', lastLine(pre.out))
  if (pre.status) stop('FAILED', `preflight: ${pre.out.split('\n').filter((l) => l.startsWith('FAIL')).join('; ')}`)
  ensureTab()
  if (!S.worktree) {
    event(slug, 'worktree', 'start', 'fresh origin/main, install + build')
    const w = script('worktree.sh', [slug]); process.stdout.write(w.out)
    if (w.status) stop('FAILED', `worktree.sh: ${lastLine(w.out)}`)
    S = loadState(slug)
    event(slug, 'worktree', 'ok', `${S.worktree} on ${S.branch} at ${S.base.slice(0, 9)}`)
  }
  let note = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const before = snapshot()
    const step = await runStep({ readonly: true, stage: 'intake', round: attempt, template: 'intake.md', prefix: 'INTAKE', cwd: S.worktree, extra: { sent_back: note } })
    auditGate(step); readOnly(before, 'intake'); tripwire('intake')
    if (step.answer.startsWith(`INTAKE ${slug} NOT_REPRODUCED`)) pause('intake', 'the bug did not reproduce on origin/main; pick another bug or sharpen the task', step.answer)
    if (step.answer.startsWith(`INTAKE ${slug} NEEDS_INPUT`)) pause('intake', step.answer, step.out)
    const problem = intakeCheck()
    event(slug, 'intake-gate', problem ? 'fail' : 'pass', problem)
    decide(slug, 'intake-gate', problem ? `test-plan.md rejected: ${problem}` : 'test-plan.md complete', 'deterministic shape check', 'test-plan.md', problem ? 'FAIL' : 'PASS')
    if (!problem) return
    note = `\nSent back by the intake gate: ${problem}. Fix test-plan.md.\n`
  }
  stop('FAILED', 'intake gate failed twice')
}

// A resumed run does not redo committed work: if the stage's commits already exist, its gate runs first and
// the session is skipped when the gate passes (idempotent resume).
const commitCount = () => Number(sh('git', ['-C', S.worktree, 'rev-list', '--count', `${S.base}..HEAD`]).stdout.trim())

async function red() {
  let note = ''
  if (commitCount() >= 1) {
    const g = script('gate-red.sh', [slug]); process.stdout.write(g.out)
    event(slug, 'red-gate', g.status ? 'fail' : 'pass', `resume, existing test commit: ${lastLine(g.out)}`)
    if (!g.status) return
    note = `\nSent back by the red gate: ${lastLine(g.out)}\nGate details: ${join(RD, 'gate', 'red.json')}. Leave exactly one test-only commit (amend it).\n`
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const step = await runStep({ stage: 'red', round: attempt, template: 'red.md', prefix: 'RED', cwd: S.worktree, extra: { sent_back: note } })
    auditGate(step); tripwire('red')
    if (step.answer.startsWith(`RED ${slug} NO_RED`)) pause('red', 'no honest failing test reproduces the bug (a red that does not fail is a finding)', step.answer)
    const g = script('gate-red.sh', [slug]); process.stdout.write(g.out)
    event(slug, 'red-gate', g.status ? 'fail' : 'pass', lastLine(g.out))
    if (!g.status) return
    note = `\nSent back by the red gate: ${lastLine(g.out)}\nGate details: ${join(RD, 'gate', 'red.json')}, output: ${join(RD, 'evidence', 'red.txt')}. Leave exactly one test-only commit (amend it).\n`
  }
  stop('FAILED', 'red gate failed twice')
}

function green(label) {
  event(slug, `gate ${label}`, 'start', 'fresh worktrees: red at commit 1, green at HEAD')
  const g = script('gate-green.sh', [slug, label]); process.stdout.write(g.out)
  event(slug, `gate ${label}`, g.status ? 'fail' : 'pass', lastLine(g.out))
  if (!g.status) S = saveState(slug, { last_green: label })
  return g
}

async function fix() {
  let note = ''
  if (commitCount() === 2) {
    const g = green('fix')
    if (!g.status) return
    note = `\nSent back by the green gate: ${lastLine(g.out)}\nDetails: ${join(RD, 'gate', 'green-fix.json')}. Keep exactly two commits (test, fix).\n`
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const step = await runStep({ stage: 'fix', round: attempt, template: 'fix.md', prefix: 'FIX', cwd: S.worktree, extra: { sent_back: note } })
    auditGate(step); tripwire('fix')
    const g = green('fix')
    if (!g.status) return
    note = `\nSent back by the green gate: ${lastLine(g.out)}\nDetails: ${join(RD, 'gate', 'green-fix.json')}. Keep exactly two commits (test, fix).\n`
  }
  stop('FAILED', 'green gate failed twice')
}

async function verify(label) {
  event(slug, `verify ${label}`, 'start', 'verify.sh: rows from the table, doctor first, unit rows, sandbox before/after')
  let r = script('verify.sh', [slug, label]); process.stdout.write(r.out)
  if (r.status === 3) {
    event(slug, `verify ${label}`, 'merge conflicts', 'scratch merge of origin/main into the sandbox stack stopped on conflicts')
    const scratch = `${WT_ROOT}/scratch-${slug}`
    const step = await runStep({ stage: 'merge-resolve', template: 'merge-resolve.md', prefix: 'MERGE', cwd: scratch })
    auditGate(step); tripwire('merge-resolve')
    const c = script('sandbox-scratch.sh', [slug, 'setup', '--continue']); process.stdout.write(c.out)
    if (c.status) stop('FAILED', `scratch setup --continue: ${lastLine(c.out)}`)
    r = script('verify.sh', [slug, label]); process.stdout.write(r.out)
  }
  const gateLine = r.out.split('\n').filter((l) => l.startsWith('VERIFY_GATE')).at(-1) ?? `VERIFY_GATE missing: ${lastLine(r.out)}`
  event(slug, `verify-gate ${label}`, r.status ? 'fail' : 'pass', gateLine)
  decide(slug, 'verify-gate', gateLine.slice(0, 300), 'exit codes recorded by verify.sh, decided by verify-gate.mjs', `verify/${label}/gate.json`, r.status ? 'FAIL' : 'PASS')
  S = saveState(slug, { last_verify: label })
  const before = snapshot()
  const step = await runStep({ readonly: true, stage: 'verify', round: label.replace(/\D/g, '') || 1, suffix: label.startsWith('r') ? '' : `-${label}`, template: 'verify.md', prefix: 'VERIFY', cwd: S.worktree,
    addDirs: [`${WT_ROOT}/scratch-${slug}`].filter(existsSync), extra: { verify_dir: join(RD, 'verify', label), label } })
  auditGate(step); readOnly(before, 'verify'); tripwire('verify')
  const file = join(RD, 'verify', label, 'verify.md')
  if (!existsSync(file) || lastLine(read(file)) !== step.answer) writeFileSync(file, `${read(file)}\n\n<!-- final message of the verify session -->\n${read(step.out)}`)
  if (r.status) pause('verify', `the verify gate failed: ${gateLine}`, `verify/${label}/gate.json, verify/${label}/verify.md`)
  if (step.answer !== `VERIFY ${slug} PASS`) pause('verify', `the verify session did not pass: ${step.answer}`, file)
}

async function blast() {
  const before = snapshot()
  const step = await runStep({ readonly: true, stage: 'blast-radius', template: 'blast-radius.md', prefix: 'BLAST', cwd: S.worktree })
  auditGate(step); readOnly(before, 'blast-radius'); tripwire('blast-radius')
  if (!existsSync(join(RD, 'blast-radius.md'))) writeFileSync(join(RD, 'blast-radius.md'), read(step.out))
  if (!step.answer.startsWith(`BLAST ${slug} `)) stop('FAILED', `blast radius gave no answer: ${step.answer}`)
}

// Everything a reader needs, as files: readers run in plan mode and must not depend on Bash being approved.
function reviewInput() {
  const dir = join(RD, 'review-input'), files = join(dir, 'files')
  mkdirSync(files, { recursive: true })
  writeFileSync(join(dir, 'diff.patch'), sh('git', ['-C', S.worktree, 'diff', `${S.base}..HEAD`]).stdout)
  writeFileSync(join(dir, 'log.txt'), sh('git', ['-C', S.worktree, 'log', '--stat', `${S.base}..HEAD`]).stdout)
  for (const f of sh('git', ['-C', S.worktree, 'diff', '--name-only', `${S.base}..HEAD`]).stdout.split('\n').filter(Boolean)) {
    mkdirSync(join(files, f, '..'), { recursive: true })
    writeFileSync(join(files, f), sh('git', ['-C', S.worktree, 'show', `HEAD:${f}`]).stdout)
  }
}

const intent = () => {
  const plan = read(join(RD, 'test-plan.md'))
  const sec = (h) => (plan.split(`\n## ${h}\n`)[1] ?? '').split('\n## ')[0].trim().replace(/\s+/g, ' ')
  return `${sec('Task')} Expected behavior: ${sec('Expected behavior')}`
}

async function review() {
  const reviewers = MODELS.stages.review.models
  // Resume: a round whose judgment is missing is redone, and reviews already answered in it are reused.
  const startRound = S.review_round && !existsSync(join(RD, `judgment-r${S.review_round}.md`)) ? S.review_round : (S.review_round ?? 0) + 1
  for (let round = startRound; round <= MODELS.max_review_rounds; round += 1) {
    S = saveState(slug, { review_round: round })
    const before = snapshot()
    reviewInput()
    const labels = ['A', 'B', 'C']
    // A review is reused on resume only if it answered, was made for the current HEAD, and was not degraded
    // (a session that got refused calls reviewed with less than the change in front of it).
    const head = sh('git', ['-C', S.worktree, 'rev-parse', 'HEAD']).stdout.trim()
    const meta = (i) => JSON.parse(read(join(RD, `review-r${round}-${reviewers[i]}.json`)) || '{}')
    const done = (i) => lastLine(read(join(RD, `review-r${round}-${reviewers[i]}.md`))).startsWith(`REVIEW ${slug} ${labels[i]} `) && meta(i).head === head && meta(i).degraded === false
    const todo = reviewers.map((m, i) => i).filter((i) => !done(i))
    if (todo.length < reviewers.length) event(slug, `review r${round}`, 'resume', `reusing answered reviews: ${reviewers.filter((m, i) => done(i)).join(', ')}`)
    const panes = {}
    if (todo.length) {
      const anchor = reviewTab(round)
      todo.forEach((i, k) => { panes[i] = k === 0 ? anchor : newPane(S.worktree, panes[todo[k - 1]], k === 1 ? 'right' : 'down') })
    }
    const ran = await Promise.all(todo.map((i) => runStep({ readonly: true, stage: 'review', round, suffix: `-${reviewers[i]}`, template: 'review.md', prefix: 'REVIEW', cwd: S.worktree,
      pane: panes[i], model: reviewers[i], mode: 'reader', extra: { reviewer: labels[i], intent: intent() } }).then((st) => ({ ...st, i }))))
    ran.forEach(auditGate); readOnly(before, 'a reviewer'); tripwire('review')
    // Non-200 responses mean some calls were refused (plan mode asks the model's safety classifier about
    // unlisted Bash; gpt-6-astra answers it with a 400). The judge sees that next to the review.
    for (const st of ran) {
      const audit = JSON.parse(read(join(RD, 'sessions', `${st.tag.replaceAll('/', '_')}-audit.json`)) || '{}')
      const refused = Object.entries(audit.by_status ?? {}).filter(([code]) => code !== '200').map(([code, n]) => `${n}x HTTP ${code}`)
      const note = refused.length ? `\n\n> Factory audit note: this session got ${refused.join(', ')} from the model; calls that needed the safety classifier were refused. Weigh what it could not check.\n` : ''
      writeFileSync(join(RD, `review-r${round}-${reviewers[st.i]}.md`), note + read(st.out))
      writeFileSync(join(RD, `review-r${round}-${reviewers[st.i]}.json`), JSON.stringify({ head, tag: st.tag, model: reviewers[st.i], degraded: refused.length > 0, refused }, null, 2) + '\n')
    }
    const files = reviewers.map((m) => join(RD, `review-r${round}-${m}.md`))
    const steps = reviewers.map((m, i) => ({ answer: lastLine(read(files[i])) }))
    const missing = steps.filter((s) => !s.answer.startsWith(`REVIEW ${slug} `))
    if (missing.length) stop('FAILED', `${missing.length} reviewer(s) gave no review: ${missing.map((s) => s.answer).join(' | ')}`)
    const judge = await runStep({ readonly: true, stage: 'judge', round, template: 'judge.md', prefix: 'JUDGE', cwd: S.worktree, mode: 'reader',
      extra: { intent: intent(), review_files: files.map((f, i) => `- Reviewer ${labels[i]} (${reviewers[i]}): ${f}`).join('\n'),
        previous_judgment: round > 1 ? ` The previous round's judgment, whose Act-on items were since fixed: ${join(RD, `judgment-r${round - 1}.md`)}.` : '' } })
    auditGate(judge); readOnly(before, 'the judge'); tripwire('judge')
    const jfile = `judgment-r${round}.md`
    writeFileSync(join(RD, jfile), read(judge.out))
    const m = judge.answer.match(new RegExp(`^JUDGE ${slug} ACT_ON (\\d+)`))
    if (!m) stop('FAILED', `the judge gave no verdict: ${judge.answer}`)
    S = saveState(slug, { last_judge: jfile })
    const acts = Number(m[1])
    decide(slug, 'judge', `round ${round}: ${acts} Act-on item(s)`, 'interrogate lead judgment over three models', jfile, acts ? 'fix round' : 'clean')
    if (!acts) return
    if (round === MODELS.max_review_rounds) pause('review', `${acts} Act-on item(s) remain after ${round} review rounds`, join(RD, jfile))
    const act = await runStep({ stage: 'act-on', round, template: 'act-on.md', prefix: 'ACTON', cwd: S.worktree, extra: { judgment: join(RD, jfile) } })
    auditGate(act); tripwire('act-on')
    if (green(`act-on-r${round}`).status) stop('FAILED', `green gate failed after the act-on fixes of round ${round}`)
    await verify(`r${round + 1}`)
  }
}

async function noComments() {
  const tree = () => sh('git', ['-C', S.worktree, 'rev-parse', 'HEAD^{tree}']).stdout.trim()
  const before = tree()
  const step = await runStep({ stage: 'no-comments', template: 'no-comments.md', prefix: 'NOCOMMENTS', cwd: S.worktree })
  auditGate(step); tripwire('no-comments')
  if (!step.answer.startsWith(`NOCOMMENTS ${slug} DONE`)) stop('FAILED', `no-comments gave no answer: ${step.answer}`)
  if (tree() === before) { event(slug, 'no-comments', 'unchanged', 'tree identical; gates still hold'); decide(slug, 'no-comments', 'no code changed', 'comment-sicko found nothing to delete in the added lines', step.out, 'unchanged'); return }
  if (green('no-comments').status) stop('FAILED', 'green gate failed after no-comments')
  await verify('nc')
}

async function publish() {
  const real = flag('publish') && process.env.FACTORY_ALLOW_PUBLISH === '1'
  event(slug, 'publish', 'start', real ? 'push + draft PR' : 'dry run: prints what it would do and stops')
  const p = script('publish.sh', real ? [slug] : [slug, '--dry-run'])
  writeFileSync(join(RD, 'publish.log'), p.out); process.stdout.write(p.out)
  const recheck = p.out.split('\n').filter((l) => l.startsWith('RECHECK')).at(-1) ?? 'RECHECK missing'
  event(slug, 'publish', p.status ? 'fail' : real ? 'published' : 'dry run ok', recheck)
  if (p.status) stop('FAILED', `publish: ${lastLine(p.out)}`)
  outcome = { verdict: real ? 'PASS' : 'PASS (dry run)', reason: real ? `${loadState(slug).pr_url}; ${recheck}` : `ready for a draft PR, nothing pushed; ${recheck}; body ${join(RD, 'pr-body.md')}` }
}

async function reflect() {
  ensureTab()
  const step = await runStep({ stage: 'reflect', template: 'reflect.md', prefix: 'REFLECT', cwd: S.worktree ?? FACTORY, writeRoot: '' })
  if (step.code === 2) event(slug, 'reflect', 'audit failed', step.tag)
  if (!existsSync(join(RD, 'reflect.md'))) writeFileSync(join(RD, 'reflect.md'), read(step.out))
}

// ---------- the run ----------
event(slug, 'run', 'start', `stages ${STAGES[from]}..${STAGES[until]} (audit log ${AUDIT_LOG})`)
try {
  if (wants('intake')) await intake()
  S = loadState(slug); ensureTab()
  if (wants('red')) await red()
  if (wants('fix')) await fix()
  if (wants('verify')) await verify('r1')
  if (wants('blast-radius')) await blast()
  if (wants('review')) await review()
  if (wants('no-comments')) await noComments()
  if (wants('publish')) await publish()
  if (outcome.verdict === 'RUNNING') outcome = { verdict: 'STOPPED', reason: `ran until ${STAGES[until]}` }
} catch (error) {
  if (!(error instanceof Stop)) {
    outcome = { verdict: 'FAILED (driver error)', reason: `driver error: ${error.stack}` }
    event(slug, 'outcome', outcome.verdict, String(error))
    decide(slug, 'outcome', `${outcome.verdict}: ${String(error)}`, 'a factory bug, not a gate verdict on the change', 'events.jsonl', outcome.verdict)
  }
}
if (wants('reflect')) { try { await reflect() } catch (error) { event(slug, 'reflect', 'error', String(error)) } }
const audit = sh('node', [join(FACTORY, 'scripts', 'audit-summary.mjs'), slug])
writeFileSync(join(RD, 'audit-summary.md'), audit.out)
writeFileSync(join(RD, 'outcome.md'), `# ${slug}: ${outcome.verdict}\n\n- reason: ${outcome.reason}\n- branch: ${S.branch} (${S.worktree})\n- events: ${join(RD, 'events.jsonl')}\n- decisions: ${join(RD, 'decisions.tsv')}\n- audit: ${join(RD, 'audit-summary.md')}\n${existsSync(join(RD, 'NEEDS-INPUT.md')) ? `- NEEDS INPUT: ${join(RD, 'NEEDS-INPUT.md')}\n` : ''}`)
event(slug, 'run', outcome.verdict, outcome.reason)
if (outcome.verdict.startsWith('PASS') || outcome.verdict === 'STOPPED') decide(slug, 'outcome', `${outcome.verdict}: ${outcome.reason}`, 'every stage up to the last requested one passed its gate', 'outcome.md', outcome.verdict)
sh('herdr', ['notification', 'show', `factory ${slug}: ${outcome.verdict}`, '--body', outcome.reason.slice(0, 180), '--sound', outcome.verdict.startsWith('PASS') ? 'done' : 'request'])
process.exit(outcome.verdict.startsWith('PASS') || outcome.verdict === 'STOPPED' ? 0 : 1)
