#!/usr/bin/env node
// Is this change security-critical? Deterministic: the diff's paths against inputs/security-critical-paths.json
// globs, and its added or removed lines against the content markers.
//   node security-check.mjs <slug>      -> runs/<slug>/security.json, prints SECURITY <slug> critical|normal
//   node security-check.mjs --audit     -> every glob must match at least one file on origin/main
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FACTORY, loadState, runDir, sh } from '../lib/common.mjs'

export const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$')
const spec = JSON.parse(readFileSync(join(FACTORY, 'inputs', 'security-critical-paths.json'), 'utf8'))

if (process.argv[2] === '--audit') {
  const files = sh('git', ['-C', FACTORY, 'ls-tree', '-r', '--full-tree', '--name-only', 'origin/main']).stdout.split('\n')
  const dead = spec.globs.filter((g) => !files.some((f) => globRe(g.glob).test(f)))
  console.log(dead.length ? `SECURITY_AUDIT FAIL globs matching nothing on origin/main: ${dead.map((g) => g.glob).join(', ')}` : `SECURITY_AUDIT OK ${spec.globs.length} globs all match files on origin/main`)
  process.exit(dead.length ? 1 : 0)
}
const slug = process.argv[2]
const { worktree, base } = loadState(slug)
const files = sh('git', ['-C', worktree, 'diff', '--name-only', `${base}..HEAD`]).stdout.split('\n').filter(Boolean)
const diff = sh('git', ['-C', worktree, 'diff', '-U0', `${base}..HEAD`]).stdout.split('\n').filter((l) => /^[+-][^+-]/.test(l))
const paths = files.flatMap((file) => spec.globs.filter((g) => globRe(g.glob).test(file)).map((g) => ({ file, glob: g.glob, why: g.why })))
const markers = spec.content_markers.flatMap((m) => { const hit = diff.find((l) => new RegExp(m.regex).test(l)); return hit ? [{ regex: m.regex, why: m.why, line: hit.slice(0, 160) }] : [] })
const result = { critical: paths.length > 0 || markers.length > 0, files, paths, markers, forces_row: spec.forces_row, pr_flag: spec.pr_flag }
writeFileSync(join(runDir(slug), 'security.json'), JSON.stringify(result, null, 2) + '\n')
console.log(`SECURITY ${slug} ${result.critical ? 'critical' : 'normal'}${result.critical ? ` (${[...paths.map((p) => p.file), ...markers.map((m) => `/${m.regex}/`)].join(', ')})` : ''}`)
