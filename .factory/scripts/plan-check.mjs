#!/usr/bin/env node
// Decide from disk whether the plan step finished, so an empty or cut-off planner reply loses nothing.
//
//   node .factory/scripts/plan-check.mjs [--slug <slug>]
//
// Prime can mark the planner done while it is still working (its task arrived late), so this first
// waits: until plan.md says `Status: final`, or until the planner's session has been quiet for
// 3 minutes, at most 40 minutes. Then it reads the slug from the `Factory slug:` line in .factory/current-task.md (or --slug), then checks
// .factory/tasks/<slug>/plan.md: a `Status: final` line, no `TODO:` left, and every section the
// planner must write. Prints one last line:
//   ANSWER PLAN <slug> .factory/tasks/<slug>/plan.md     plan is final, build can start
//   ANSWER PLAN_MISSING <slug> <reason>                  plan goes back to the planner to continue
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SECTIONS = ['Goal', 'Files to change', 'Failing tests to add', 'User-facing copy', 'Gate commands', 'Acceptance checks', 'Safety fact']

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const slugIndex = process.argv.indexOf('--slug')
const taskFile = join(repo, '.factory', 'current-task.md')
const fromTask = existsSync(taskFile) ? readFileSync(taskFile, 'utf8').match(/^Factory slug:\s*(\S+)/m)?.[1] : undefined
const slug = slugIndex > 0 ? process.argv[slugIndex + 1] : fromTask

function answer(line) {
  console.log(`ANSWER ${line}`)
  process.exit(0)
}

if (!slug) answer('PLAN_MISSING unknown no `Factory slug:` line in .factory/current-task.md')
const relative = `.factory/tasks/${slug}/plan.md`
const file = join(repo, relative)

function plannerLastActive() {
  const root = join(homedir(), '.prime', 'agent', 'session-artifacts')
  let newest = 0
  for (const parent of existsSync(root) ? readdirSync(root) : []) {
    const head = join(homedir(), '.prime', 'agent', 'sessions', `${parent}.jsonl`)
    if (!existsSync(head) || !readFileSync(head, 'utf8').slice(0, 400).includes(`"cwd":"${repo}"`)) continue
    for (const child of readdirSync(join(root, parent)).filter((name) => name.startsWith('sub-'))) {
      const meta = join(root, parent, child, 'rlm-subagent.json')
      if (!existsSync(meta)) continue
      const { sessionName = '', sessionFile = '' } = JSON.parse(readFileSync(meta, 'utf8'))
      if (!sessionName.startsWith('sw-plan-') || sessionName.startsWith('sw-plan-check-') || !existsSync(sessionFile)) continue
      newest = Math.max(newest, statSync(sessionFile).mtimeMs)
    }
  }
  return newest
}

const isFinal = () => existsSync(file) && /^Status:\s*final\b/m.test(readFileSync(file, 'utf8'))
const deadline = Date.now() + 40 * 60_000
while (!isFinal() && Date.now() < deadline && Date.now() - plannerLastActive() < 3 * 60_000) {
  await new Promise((done) => setTimeout(done, 15_000))
}
if (!existsSync(file)) answer(`PLAN_MISSING ${slug} no plan.md yet`)
const text = readFileSync(file, 'utf8')
const status = text.match(/^Status:\s*\S+/m)?.[0] ?? 'no Status line'
const headings = [...text.matchAll(/^#{1,4}\s+(.+?)\s*$/gm)].map((match) => match[1].toLowerCase())
const missing = SECTIONS.filter((section) => !headings.some((heading) => heading.startsWith(section.toLowerCase())))
const todos = text.split('\n').filter((line) => /\bTODO:/.test(line)).length

const problems = []
if (status !== 'Status: final') problems.push(`status is "${status.slice(0, 40)}" not "Status: final"`)
if (todos) problems.push(`${todos} TODO left`)
if (missing.length) problems.push(`missing sections: ${missing.join(', ')}`)
console.log(`plan.md: ${text.length} bytes, ${headings.length} headings, ${todos} TODO`)
if (problems.length) answer(`PLAN_MISSING ${slug} ${problems.join('; ')}`)
answer(`PLAN ${slug} ${relative}`)
