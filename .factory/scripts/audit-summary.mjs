#!/usr/bin/env node
// Audit-log counts per step tag for one run: every request the run's sessions (and preflight pings) sent
// through the audit proxy, with model, pin, answering peer and status. Usage: node audit-summary.mjs <slug>
import { readFileSync } from 'node:fs'
import { AUDIT_LOG, PEER } from '../lib/common.mjs'

const slug = process.argv[2]
const rows = readFileSync(AUDIT_LOG, 'utf8').split('\n').filter((l) => l.includes(`"${slug}/`)).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  .filter((r) => r.step?.startsWith(`${slug}/`))
const tags = [...new Set(rows.map((r) => r.step))]
const short = (p) => (p === PEER ? 'GesundAI' : p ? p.slice(0, 10) : 'none')
const count = (list) => Object.entries(list.reduce((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {})).map(([k, v]) => `${k}×${v}`).join(' ')
console.log(`# Audit log for ${slug}\n\nSource: ${AUDIT_LOG} (${rows.length} requests). count_tokens is answered locally by the buyer, so it has no peer.\n`)
console.log('| step tag | requests | model | pin | source | messages: peer | messages: status | count_tokens |\n| --- | --- | --- | --- | --- | --- | --- | --- |')
let bad = 0
for (const tag of tags) {
  const mine = rows.filter((r) => r.step === tag)
  const msgs = mine.filter((r) => !r.path.includes('count_tokens'))
  const offPeer = msgs.filter((r) => r.status === 200 && r.peer !== PEER).length + mine.filter((r) => r.pin !== PEER).length
  bad += offPeer
  console.log(`| ${tag.slice(slug.length + 1)} | ${mine.length} | ${count(mine.map((r) => r.model))} | ${count(mine.map((r) => short(r.pin)))} | ${count(mine.map((r) => r.source))} | ${count(msgs.map((r) => short(r.peer)))} | ${count(msgs.map((r) => r.status))} | ${mine.length - msgs.length} |`)
}
console.log(`\n${bad ? `**${bad} request(s) not pinned to or not answered by GesundAI.**` : 'Every request was pinned to GesundAI, and every answered /v1/messages request was answered by GesundAI.'}`)
