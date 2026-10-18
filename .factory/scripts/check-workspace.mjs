#!/usr/bin/env node
// Factory self-check: a step session spawns in the run's own, fresh Herdr workspace and nowhere else.
// Creates workspace "factory-ws-smoke-<time>" through lib/workspace.mjs, runs one pinned native-step session in
// a pane split inside it, checks the pane id belongs to that workspace and that every other workspace's tabs
// and panes are unchanged, then closes only the test workspace. Exit 0 = proven.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FACTORY, herdr, runDir } from '../lib/common.mjs'
import { ensureWorkspace, workspaceExists } from '../lib/workspace.mjs'

const others = () => Object.fromEntries((herdr(['workspace', 'list'])?.workspaces ?? []).map((w) => [w.workspace_id, `${w.tab_count} tabs, ${w.pane_count} panes`]))
const before = others()
const label = `factory-ws-smoke-${Date.now().toString(36)}`
const ws = ensureWorkspace(label, FACTORY, undefined)
console.log(`created workspace ${label} = ${ws.id} (root pane ${ws.rootPane})`)
let ok = true
try {
  const pane = herdr(['pane', 'split', ws.rootPane, '--direction', 'right', '--cwd', FACTORY, '--no-focus'])?.pane?.pane_id
  console.log(`session pane ${pane}`)
  if (!pane?.startsWith(`${ws.id}:`)) { console.log(`FAIL pane ${pane} is not in ${ws.id}`); ok = false }
  const dir = join(runDir('smoke'), 'ws'); mkdirSync(dir, { recursive: true })
  const prompt = join(dir, 'prompt.md')
  writeFileSync(prompt, 'Workspace smoke test. Do not use any tool. Reply with exactly one line: `SMOKE done`.\n')
  const r = spawnSync('node', [join(FACTORY, 'scripts/native-step.mjs'), '--slug', 'smoke', '--stage', 'fix', '--tag', `smoke/ws.${Date.now().toString(36)}`, '--model', 'claude-opus-5.5',
    '--mode', 'writer', '--pane', pane, '--cwd', FACTORY, '--prompt', prompt, '--answer-prefix', 'SMOKE', '--out', join(dir, 'out.md'), '--timeout-min', '5', '--stall-min', '3', '--keep-pane'], { encoding: 'utf8' })
  process.stdout.write(r.stdout)
  const agentPane = (herdr(['pane', 'list', '--workspace', ws.id])?.panes ?? []).find((p) => p.pane_id === pane)
  console.log(`native-step exit ${r.status}; pane ${pane} in workspace ${agentPane?.workspace_id ?? '?'}, agent ${agentPane?.agent ?? 'none'}`)
  if (r.status !== 0 || agentPane?.workspace_id !== ws.id) ok = false
  const after = others()
  const changed = Object.keys(before).filter((id) => before[id] !== after[id])
  console.log(changed.length ? `FAIL other workspaces changed: ${changed.map((id) => `${id} ${before[id]} -> ${after[id]}`).join('; ')}` : `other workspaces unchanged (${Object.keys(before).length})`)
  if (changed.length) ok = false
} finally {
  herdr(['workspace', 'close', ws.id])
  const gone = !workspaceExists(ws.id)
  console.log(gone ? `closed test workspace ${ws.id}` : `FAIL test workspace ${ws.id} still open`)
  if (!gone) ok = false
}
console.log(ok ? 'WORKSPACE OK: the step session ran in its own fresh workspace; nothing else changed' : 'WORKSPACE FAIL')
process.exit(ok ? 0 : 1)
