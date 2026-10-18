#!/usr/bin/env node
// Run one factory step in a native coding agent (Claude Code or Codex) inside a visible Herdr pane.
//
//   node .factory/scripts/native-step.mjs --step build --slug <slug> --agent codex --model gpt-6.1-sol \
//     --template .factory/prompts/build.md [--var sent_back=...] [--answer-file .factory/tasks/<slug>/build.md] \
//     [--effort medium] [--timeout-min 40] [--interactive]
//
// --template fills {slug} and every --var key=value into .factory/tasks/<slug>/<step>.prompt.md.
// --answer-file prints `ANSWER <STEP> <slug> ...` from that file's last matching line, only if the step rewrote it.
//
// Opens a pane labelled "<step> <round> · <agent> · <model>" next to the Prime lead, starts the agent
// there pinned to GesundAI, sends the prompt, waits until the agent is idle, and appends
// {step, round, agent, session_id, pane, model, started_at, ended_at, status, resume} to
// .factory/tasks/<slug>/sessions.jsonl. The pane stays open until the next step opens, so the human
// can watch, type into it, or resume it later. Without Herdr it falls back to `claude -p` / `codex exec`.
// --interactive (needs Herdr): start the agent, send the prompt, record the session as `interactive`, and
// exit at once. The conversation then continues in the pane with the human; the step's file is the hand-off.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const GESUNDAI_PEER = '983e9de990b9ac8d36d373db5d0b49a4d7f7d826'
const BUYER_URL = process.env.ANTSEED_BUYER_URL ?? 'http://localhost:8377'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index > 0 && process.argv[index + 1]) return process.argv[index + 1]
  if (fallback === undefined) throw new Error(`missing --${name}`)
  return fallback
}

const step = arg('step')
const slug = arg('slug')
const agent = arg('agent', 'claude')
if (!['claude', 'codex'].includes(agent)) throw new Error(`--agent must be claude or codex, got ${agent}`)
const model = arg('model')
const effort = arg('effort', '')
const templateFile = arg('template', '')
const promptFileArg = arg('prompt-file', '')
if (!templateFile && !promptFileArg) throw new Error('pass --template <file> or --prompt-file <file>')
const vars = { slug }
process.argv.forEach((value, index) => {
  if (value !== '--var') return
  const [key, ...rest] = String(process.argv[index + 1] ?? '').split('=')
  vars[key] = rest.join('=')
})
const timeoutMs = Number(arg('timeout-min', '40')) * 60_000
const answerFile = arg('answer-file', '')
const interactive = process.argv.includes('--interactive')
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const taskDir = join(repo, '.factory', 'tasks', slug)
mkdirSync(taskDir, { recursive: true })
const promptFile = templateFile ? join(taskDir, `${step}.prompt.md`) : resolve(promptFileArg)
if (templateFile) {
  const filled = readFileSync(resolve(repo, templateFile), 'utf8').replace(/\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match))
  writeFileSync(promptFile, filled)
}
const prompt = readFileSync(promptFile, 'utf8')
let sessionId = agent === 'claude' ? randomUUID() : ''
const sessionsFile = join(taskDir, 'sessions.jsonl')
const round = 1 + (existsSync(sessionsFile) ? readFileSync(sessionsFile, 'utf8').split('\n').filter((line) => line.includes(`"step":"${step}"`)).length : 0)
const startedAt = new Date().toISOString()

const NODE24_BIN = process.env.FACTORY_NODE_BIN ?? join(process.env.HOME ?? '', '.volta/tools/image/node/24.21.0/bin')
const shellEnvFile = join(taskDir, `${step}.shell-env.sh`)
writeFileSync(shellEnvFile, `export PATH="${NODE24_BIN}:$PATH"\n`)
const shellPath = `${NODE24_BIN}:${process.env.PATH ?? ''}`
const env = agent === 'claude'
  ? {
      CLAUDE_ENV_FILE: shellEnvFile,
      ANTHROPIC_BASE_URL: BUYER_URL,
      ANTHROPIC_AUTH_TOKEN: 'antseed',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_CUSTOM_HEADERS: `x-antseed-pin-peer: ${GESUNDAI_PEER}`,
    }
  : { GESUNDAI_KEY: 'antseed', PATH: shellPath }
const agentArgs = agent === 'claude'
  ? [
      '--session-id', sessionId,
      '--model', model,
      '--name', `${step} · ${slug}`,
      '--permission-mode', 'bypassPermissions',
      ...(effort ? ['--effort', effort] : []),
    ]
  : [
      '--model', model,
      '-c', 'model_provider="gesundai"',
      '-c', `model_providers.gesundai={name="GesundAI",base_url="${BUYER_URL}/v1",wire_api="responses",env_key="GESUNDAI_KEY",http_headers={"x-antseed-pin-peer"="${GESUNDAI_PEER}"}}`,
      '-c', `shell_environment_policy.set={PATH="${shellPath}"}`,
      '-c', `projects={"${repo}"={trust_level="trusted"}}`,
      ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
      '--dangerously-bypass-approvals-and-sandbox',
      '--cd', repo,
    ]

function record(status, extra = {}) {
  const resume = !sessionId ? '' : agent === 'claude' ? `claude --resume ${sessionId}` : `codex resume ${sessionId}`
  const entry = { step, round, agent, session_id: sessionId, model, started_at: startedAt, ended_at: new Date().toISOString(), status, resume, ...extra }
  appendFileSync(sessionsFile, `${JSON.stringify(entry)}\n`)
  console.log(JSON.stringify(entry))
}

function findCodexSession() {
  const root = join(process.env.HOME ?? '', '.codex', 'sessions')
  const started = Date.parse(startedAt)
  const day = new Date(started)
  const dirs = [0, 1].map((offset) => {
    const date = new Date(day.getTime() + offset * 86_400_000)
    return join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'))
  })
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).sort().reverse()) {
      const file = join(dir, name)
      if (statSync(file).mtimeMs < started) continue
      const meta = JSON.parse(readFileSync(file, 'utf8').split('\n', 1)[0]).payload ?? {}
      if (resolve(meta.cwd ?? '') === repo && Date.parse(meta.timestamp) >= started - 5000) return meta.id
    }
  }
  return ''
}

function herdr(args, options = {}) {
  const out = execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
  try { return JSON.parse(out).result } catch { return out }
}

function findFactoryTab() {
  const workspace = process.env.HERDR_WORKSPACE_ID
  const tabs = herdr(['tab', 'list', ...(workspace ? ['--workspace', workspace] : [])]).tabs ?? []
  const allPanes = herdr(['pane', 'list']).panes ?? []
  const lead = allPanes.find((pane) => pane.agent === 'prime-agent' && resolve(pane.cwd ?? '') === repo)
  if (lead) return { tab: lead.tab_id, anchor: lead.pane_id }
  const panes = allPanes.filter((pane) => !workspace || pane.workspace_id === workspace)
  const tab = tabs.find((candidate) => candidate.label?.includes('factory')) ?? tabs[0]
  return { tab: tab?.tab_id, anchor: panes.find((pane) => pane.tab_id === tab?.tab_id)?.pane_id }
}

if (process.env.HERDR_ENV !== '1' && !process.env.HERDR_WORKSPACE_ID) {
  if (interactive) throw new Error('--interactive needs Herdr (run inside a Herdr pane or set HERDR_WORKSPACE_ID)')
  const [command, args] = agent === 'claude' ? ['claude', ['-p', ...agentArgs, prompt]] : ['codex', ['exec', ...agentArgs.filter((value) => value !== '--cd' && value !== repo), prompt]]
  const result = spawnSync(command, args, { cwd: repo, env: { ...process.env, ...env }, stdio: 'inherit', timeout: timeoutMs })
  record(result.status === 0 ? 'done' : 'failed', { mode: 'print' })
  process.exit(result.status ?? 1)
}

if (process.platform === 'darwin') spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref()
const { tab, anchor } = findFactoryTab()
for (const old of herdr(['pane', 'list']).panes ?? []) {
  if (old.tab_id === tab && /^(shape|plan|build|review|verify)( \d+)? · (claude|codex)/.test(old.label ?? '') && old.agent_status !== 'working') {
    spawnSync('herdr', ['pane', 'close', old.pane_id])
  }
}
const split = herdr(['pane', 'split', anchor, '--direction', 'right', '--cwd', repo, '--no-focus', ...Object.entries(env).map(([key, value]) => ['--env', `${key}=${value}`]).flat()])
const pane = split.pane.pane_id
herdr(['pane', 'rename', pane, `${step} ${round} · ${agent} · ${model}${effort ? `·${effort}` : ''}`])
const agentName = `${step}${round}-${slug}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32)
let started = false
for (let attempt = 0; attempt < 20 && !started; attempt += 1) {
  try {
    herdr(['agent', 'start', agentName, '--kind', agent, '--pane', pane, '--timeout', '120000', '--', ...agentArgs])
    started = true
  } catch (error) {
    if (!String(error.stderr ?? '').includes('agent_pane_busy')) {
      spawnSync('herdr', ['pane', 'close', pane])
      throw error
    }
    await new Promise((done) => setTimeout(done, 500))
  }
}
if (!started) throw new Error(`pane ${pane} never became an available shell`)
console.log(`${step}: ${agent} in pane ${pane}${sessionId ? ` (session ${sessionId})` : ''}`)

const instruction = `Read and follow the instructions in ${promptFile} exactly. When you are done, your last message must be the final answer line it asks for.`
if (interactive) {
  const sent = spawnSync('herdr', ['agent', 'prompt', agentName, instruction], { encoding: 'utf8' })
  if (sent.status !== 0) throw new Error(`could not send the prompt to ${agentName}: ${sent.stderr}`)
  record('interactive', { pane, herdr_agent: agentName, mode: 'herdr' })
  console.log(`${step} is running interactively in pane ${pane}; talk to it there.`)
  process.exit(0)
}
const wait = spawnSync('herdr', ['agent', 'prompt', agentName, instruction, '--wait', '--timeout', String(timeoutMs)], { encoding: 'utf8' })
let state = ''
try { state = JSON.parse(wait.stdout).result?.agent?.agent_status ?? '' } catch {}
const deadline = Date.now() + timeoutMs
while (wait.status !== 0 && !['idle', 'done', 'blocked'].includes(state) && Date.now() < deadline) {
  const again = spawnSync('herdr', ['agent', 'wait', agentName, '--timeout', String(Math.min(60000, deadline - Date.now()))], { encoding: 'utf8' })
  try { state = JSON.parse(again.stdout).result?.agent?.agent_status ?? state } catch {}
  if (again.status !== 0 && !String(again.stderr ?? '').includes('timeout')) await new Promise((done) => setTimeout(done, 2000))
}
const status = state === 'blocked' ? 'blocked' : wait.status === 0 || ['idle', 'done'].includes(state) ? 'done' : 'timeout'
let finalPane = pane
try {
  const info = herdr(['agent', 'get', agentName]).agent
  finalPane = info?.pane_id ?? pane
  if (!sessionId && info?.agent_session?.kind === 'id') sessionId = info.agent_session.value
} catch {}
if (!sessionId && agent === 'codex') sessionId = findCodexSession()
record(status, { pane: finalPane, herdr_agent: agentName, mode: 'herdr' })
if (status === 'blocked') {
  spawnSync('herdr', ['notification', 'show', `factory: ${step} needs you`, '--body', `pane ${finalPane} is waiting for input`, '--sound', 'request'])
}
if (answerFile) {
  const path = resolve(repo, answerFile)
  const fresh = existsSync(path) && statSync(path).mtimeMs >= Date.parse(startedAt)
  const pattern = new RegExp(`^${step.toUpperCase()} \\S+ \\S+.*$`, 'gm')
  const line = fresh ? [...readFileSync(path, 'utf8').matchAll(pattern)].at(-1)?.[0]?.trim() : undefined
  console.log(`ANSWER ${line ?? `${step.toUpperCase()} ${slug} ${status === 'done' ? 'NO_ANSWER' : status.toUpperCase()}`}`)
}
process.exit(status === 'done' ? 0 : 1)
