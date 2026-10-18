#!/usr/bin/env node
// Run one factory step as a fresh, pinned Claude Code session in a Herdr pane, wait for it, audit it.
//
//   node native-step.mjs --slug <slug> --stage <stage> --tag <step tag> --model <model> --mode writer|reader
//     --pane <herdr pane> --cwd <dir> --prompt <prompt file> --answer-prefix <WORD> --out <final message file>
//     [--effort high] [--timeout-min 45] [--stall-min 6] [--add-dir <dir>]... [--keep-pane]
//
// The session gets its own --settings file: the audit proxy as ANTHROPIC_BASE_URL, the GesundAI pin and
// x-factory-step headers, every model alias and the subagent model set to --model (subagents cannot drift),
// DISABLE_AUTOUPDATER, and a deny list for every GitHub write. As belt and braces the session's git has an
// unusable push URL and gh an unusable token, so a push or PR cannot happen even through `bash -c`.
// Writers: acceptEdits + an explicit tool allowlist (root refuses --dangerously-skip-permissions).
// Readers: plan mode, Read/Grep/Glob and read-only git only; their review is their final message.
//
// Completion: Herdr reports idle/done and the transcript's last entry is a finished assistant message.
// Stall: not idle, no new audit-log request and no transcript growth for --stall-min minutes, and no tool
// call in flight: the pane is read (saved as evidence) and nudged with Enter once; a second stall fails.
// Exit: 0 answered, 1 no answer line, 2 audit failed, 3 stalled or timed out, 4 could not start.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { auditRows, auditStep, herdr, runDir, sh } from '../lib/common.mjs'
import { DENY, sessionEnv } from '../lib/session-env.mjs'

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1]
  if (fallback === undefined) { console.error(`missing --${name}`); process.exit(4) }
  return fallback
}
const opts = (name) => argv.flatMap((v, i) => (v === `--${name}` ? [argv[i + 1]] : []))

const slug = opt('slug'), stage = opt('stage'), tag = opt('tag'), model = opt('model'), mode = opt('mode')
const pane = opt('pane'), cwd = resolve(opt('cwd')), promptFile = resolve(opt('prompt'))
const answerPrefix = opt('answer-prefix'), outFile = resolve(opt('out'))
const effort = opt('effort', 'high'), timeoutMs = Number(opt('timeout-min', '45')) * 60_000
const stallMs = Number(opt('stall-min', '6')) * 60_000
const dir = runDir(slug)
mkdirSync(join(dir, 'settings'), { recursive: true })
mkdirSync(join(dir, 'sessions'), { recursive: true })

const WRITER_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'TodoWrite', 'Task']
const READER_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)']
const NEVER = ['AskUserQuestion', 'EnterPlanMode', 'WebFetch', 'WebSearch']
const READER_NEVER = ['Edit', 'Write', 'NotebookEdit', 'ExitPlanMode', 'Task']

const settingsFile = join(dir, 'settings', `${tag.replaceAll('/', '_')}.json`)
const env = sessionEnv(model, tag)
const allow = mode === 'reader' ? READER_TOOLS : WRITER_TOOLS
const deny = mode === 'reader' ? [...DENY, ...NEVER, ...READER_NEVER] : [...DENY, ...NEVER]
writeFileSync(settingsFile, JSON.stringify({ env, permissions: { allow, deny } }, null, 2) + '\n')

const sessionId = randomUUID()
const name = `f-${stage}-${sessionId.slice(0, 6)}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32)
const claudeArgs = [
  '--model', model, '--settings', settingsFile, '--session-id', sessionId, '--name', `${slug} · ${tag.split('/').pop()} · ${model}`,
  '--effort', effort, '--permission-mode', mode === 'reader' ? 'plan' : 'acceptEdits',
  '--allowedTools', ...allow, '--disallowedTools', ...deny,
  '--add-dir', dir, ...opts('add-dir').flatMap((d) => ['--add-dir', d]),
]
const transcript = join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
const startedAt = new Date().toISOString()
const record = (status, extra = {}) => {
  const entry = { slug, stage, tag, model, mode, pane, herdr_agent: name, session_id: sessionId, settings: settingsFile, transcript, started_at: startedAt,
    ended_at: new Date().toISOString(), status, resume: `cd ${cwd} && claude --resume ${sessionId} --settings ${settingsFile}`,
    command: `claude ${claudeArgs.map((a) => (/[\s*()]/.test(a) ? `'${a}'` : a)).join(' ')}`, ...extra }
  appendFileSync(join(dir, 'sessions.jsonl'), JSON.stringify(entry) + '\n')
}
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${tag}: ${msg}`)
const snap = (label) => {
  const r = sh('herdr', ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '60'])
  const file = join(dir, 'sessions', `${tag.replaceAll('/', '_')}-${label}.txt`)
  writeFileSync(file, r.stdout ?? '')
  return file
}

herdr(['pane', 'rename', pane, `${tag.split('/').pop()} · ${model}`])
log(`starting claude ${model} (${mode}) in ${pane}, session ${sessionId}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const screenText = () => (sh('herdr', ['pane', 'read', pane, '--source', 'visible']).stdout ?? '').replace(/\s+/g, ' ')
// The transcript path is derived from cwd, so the pane's shell must be in exactly that directory.
sh('herdr', ['pane', 'run', pane, `cd '${cwd}'`])
await sleep(800)
const start = sh('herdr', ['agent', 'start', name, '--kind', 'claude', '--pane', pane, '--timeout', '120000', '--', ...claudeArgs])
// A first launch in a new worktree shows the folder-trust dialog, and Herdr may already report the agent as
// ready. The factory created that folder, so accept it. The default option is "No, exit": move down first.
for (let i = 0; i < 8; i += 1) {
  if (/Yes, I trust this folder/.test(screenText())) {
    log('folder trust dialog: choosing "Yes, I trust this folder" (the factory created this folder)')
    sh('herdr', ['pane', 'send-keys', pane, 'down'])
    await sleep(700)
    sh('herdr', ['pane', 'send-keys', pane, 'enter'])
    await sleep(3000)
    sh('herdr', ['agent', 'wait', name, '--until', 'idle', '--until', 'done', '--timeout', '60000'])
    break
  }
  if (/accept edits on|plan mode on/.test(screenText())) break
  await sleep(1500)
}
const ready = sh('herdr', ['agent', 'get', name])
if (!/"agent_status":"(idle|done)"/.test(ready.stdout ?? '') || /trust this folder/.test(screenText())) {
  log(`could not start: ${start.out.slice(0, 400)} ${ready.out.slice(0, 300)}`)
  record('start-failed', { snapshot: snap('start') })
  process.exit(4)
}

const instruction = `Read ${promptFile} with the Read tool and follow it exactly. Work autonomously: never ask questions, nobody will answer. Your last message must end with the final answer line that file asks for.`
const prompted = sh('herdr', ['agent', 'prompt', name, instruction, '--wait', '--timeout', '90000'])
log(`prompt submitted (${prompted.status === 0 ? 'ok' : prompted.out.slice(0, 200)})`)

function transcriptState() {
  if (!existsSync(transcript)) return { size: 0, done: false, text: '' }
  const lines = readFileSync(transcript, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  const turns = lines.filter((e) => e.type === 'assistant' || e.type === 'user')
  const last = turns.at(-1)
  const lastAssistant = [...turns].reverse().find((e) => e.type === 'assistant')
  const id = lastAssistant?.message?.id
  const blocks = turns.filter((e) => e.type === 'assistant' && e.message?.id === id).flatMap((e) => e.message?.content ?? [])
  const pendingTool = last?.type === 'assistant' && blocks.some((b) => b.type === 'tool_use')
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
  return { size: statSync(transcript).size, done: last?.type === 'assistant' && !pendingTool && text.length > 0, pendingTool, text }
}

const deadline = Date.now() + timeoutMs
let lastActivity = Date.now(), lastRows = auditRows(tag).length, lastSize = 0, nudged = 0, idleStreak = 0, status = 'timeout'
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 15_000))
  const agent = herdr(['agent', 'get', name])?.agent
  const state = agent?.agent_status ?? 'gone'
  const rows = auditRows(tag).length
  const t = transcriptState()
  if (rows !== lastRows || t.size !== lastSize) { lastActivity = Date.now(); lastRows = rows; lastSize = t.size; nudged = Math.min(nudged, 1) }
  if (state === 'gone') { status = 'exited'; break }
  if ((state === 'idle' || state === 'done') && t.done) { if (++idleStreak >= 2) { status = 'done'; break } } else idleStreak = 0
  const quietMs = Date.now() - lastActivity
  if (quietMs > stallMs && !(state === 'working' && t.pendingTool)) {
    const evidence = snap(`stall-${nudged + 1}`)
    if (nudged === 0) {
      log(`stalled ${Math.round(quietMs / 60000)} min (state ${state}, no audit rows, no transcript growth): pressing Enter once; screen saved to ${evidence}`)
      sh('herdr', ['agent', 'send-keys', name, 'enter'])
      nudged = 1; lastActivity = Date.now()
    } else {
      log(`still stalled after the nudge; giving up. Screen: ${evidence}`)
      sh('herdr', ['notification', 'show', `factory ${slug}: ${tag} stalled`, '--body', `pane ${pane}; screen in ${evidence}`, '--sound', 'request'])
      status = 'stalled'; break
    }
  }
}

const t = transcriptState()
writeFileSync(outFile, t.text + '\n')
const audit = auditStep(tag, model)
writeFileSync(join(dir, 'sessions', `${tag.replaceAll('/', '_')}-audit.json`), JSON.stringify(audit, null, 2) + '\n')
const answer = t.text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
const answered = status === 'done' && answer.startsWith(`${answerPrefix} `)
record(status, { answer, audit: { ok: audit.ok, messages: audit.messages, problems: audit.problems }, out: outFile })
log(`${status}; audit ${audit.ok ? 'ok' : 'FAILED'} (${audit.messages} requests, peers ${audit.peers.join(',')}, ${JSON.stringify(audit.by_status)})${audit.ok ? '' : ` ${audit.problems.join('; ')}`}`)
console.log(`ANSWER ${answered ? answer : `${answerPrefix} NO_ANSWER ${status}`}`)
if (!argv.includes('--keep-pane') && status === 'done' && audit.ok) sh('herdr', ['pane', 'close', pane])
process.exit(!audit.ok ? 2 : status === 'stalled' || status === 'timeout' ? 3 : answered ? 0 : 1)
