// Shared constants and helpers for the factory driver and its Node scripts.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FACTORY = dirname(dirname(fileURLToPath(import.meta.url)))
export const PSTACK = process.env.PSTACK_DIR ?? '/root/.claude/plugins/cache/pstack-local/pstack/0.15.25'
export const SKILLS = join(PSTACK, 'skills')
export const PEER = '983e9de990b9ac8d36d373db5d0b49a4d7f7d826'
export const AUDIT_URL = process.env.FACTORY_AUDIT_URL ?? 'http://127.0.0.1:18377'
export const AUDIT_LOG = process.env.FACTORY_AUDIT_LOG ?? '/root/.herdr/sandbox-verify-skill-pin.jsonl'
export const WT_ROOT = process.env.FACTORY_WT_ROOT ?? '/root/.herdr/worktrees/antseed'
export const SANDBOX_REF = process.env.FACTORY_SANDBOX_REF ?? 'origin/codex/sandbox-stack'
export const NODE_BIN = process.env.FACTORY_NODE_BIN ?? '/usr/local/bin'
export const MODELS = JSON.parse(readFileSync(join(FACTORY, 'inputs', 'models.json'), 'utf8'))

export const runDir = (slug) => join(FACTORY, 'runs', slug)

export function sh(file, args, opts = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
  return { ...r, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

export function herdr(args) {
  const r = sh('herdr', args)
  try { return JSON.parse(r.stdout).result } catch { return undefined }
}

export function loadState(slug) {
  const p = join(runDir(slug), 'state.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
}

export function saveState(slug, patch) {
  const p = join(runDir(slug), 'state.json')
  mkdirSync(dirname(p), { recursive: true })
  const next = { ...loadState(slug), ...patch }
  writeFileSync(p, JSON.stringify(next, null, 2) + '\n')
  return next
}

// One row per decision, in the pstack show-me-your-work format, through its own log.sh.
export function decide(slug, phase, decision, why, evidence, result) {
  sh('bash', [join(SKILLS, 'show-me-your-work/scripts/log.sh'), join(runDir(slug), 'decisions.tsv'), phase, decision, why, evidence, result])
}

export function event(slug, step, status, detail = '') {
  const entry = { at: new Date().toISOString(), step, status, detail }
  mkdirSync(runDir(slug), { recursive: true })
  appendFileSync(join(runDir(slug), 'events.jsonl'), JSON.stringify(entry) + '\n')
  console.log(`[${entry.at.slice(11, 19)}] ${step}: ${status}${detail ? ` | ${detail}` : ''}`)
}

// NEEDS INPUT: the blocked part pauses, everything unblocked keeps going (principle-never-block-on-the-human).
export function needsInput(slug, stage, question, context) {
  const file = join(runDir(slug), 'NEEDS-INPUT.md')
  if (!existsSync(file)) writeFileSync(file, `# NEEDS INPUT: ${slug}\n\nEach item blocks only the stage it names. Answer by editing this file or re-running that stage.\n`)
  appendFileSync(file, `\n## ${new Date().toISOString()} ${stage}\n\n- Question: ${question}\n- Context: ${context}\n`)
  sh('herdr', ['notification', 'show', `factory ${slug}: needs input (${stage})`, '--body', question.slice(0, 180), '--sound', 'request'])
  return file
}

export function auditRows(tag) {
  if (!existsSync(AUDIT_LOG)) return []
  return readFileSync(AUDIT_LOG, 'utf8').split('\n').filter((l) => l.includes(`"${tag}"`)).flatMap((l) => {
    try { const r = JSON.parse(l); return r.step === tag ? [r] : [] } catch { return [] }
  })
}

// Every model request of a step must be the step's model, pinned to GesundAI, and answered by GesundAI.
// count_tokens is answered locally by the buyer (no peer), so it is counted but not required to carry a peer.
export function auditStep(tag, model) {
  const rows = auditRows(tag)
  const messages = rows.filter((r) => r.path.startsWith('/v1/messages') && !r.path.includes('count_tokens'))
  const problems = []
  if (!messages.length) problems.push('no /v1/messages request reached the audit proxy')
  for (const r of rows) {
    if (r.model !== model) problems.push(`model ${r.model} at ${r.ts}`)
    if (r.pin !== PEER) problems.push(`pin ${r.pin} at ${r.ts}`)
    if (r.source !== 'claude-code') problems.push(`source ${r.source} at ${r.ts}`)
  }
  for (const r of messages) if (r.status === 200 && r.peer !== PEER) problems.push(`answered by ${r.peer} at ${r.ts}`)
  const byStatus = {}
  for (const r of messages) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
  return {
    tag, model, requests: rows.length, messages: messages.length, count_tokens: rows.length - messages.length,
    by_status: byStatus, peers: [...new Set(messages.map((r) => r.peer ?? 'none'))], ok: problems.length === 0, problems: [...new Set(problems)].slice(0, 10),
  }
}

// Lines of a file (or ''), and the last non-empty line.
export const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
export const lastLine = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
