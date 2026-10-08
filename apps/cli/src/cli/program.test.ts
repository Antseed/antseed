import assert from 'node:assert/strict'
import test from 'node:test'
import type { Command } from 'commander'
import { createProgram } from './program.js'

function walk(command: Command, path: string[], visit: (command: Command, path: string[]) => void): void {
  visit(command, path)
  for (const sub of command.commands) walk(sub, [...path, sub.name()], visit)
}

test('the full antseed program builds without duplicate command names or aliases', () => {
  const program = createProgram()
  const problems: string[] = []
  let count = 0
  walk(program, ['antseed'], (command, path) => {
    count += 1
    const seen = new Map<string, string>()
    for (const sub of command.commands) {
      for (const name of [sub.name(), ...sub.aliases()]) {
        const previous = seen.get(name)
        if (previous) problems.push(`${path.join(' ')}: "${name}" is used by both "${previous}" and "${sub.name()}"`)
        else seen.set(name, sub.name())
      }
    }
  })
  assert.deepEqual(problems, [])
  assert.ok(count > 50, `walked ${count} commands`)
})

test('gateway export is registered once and handles both CSV and --out bundles', () => {
  const gateway = createProgram().commands.find((command) => command.name() === 'gateway')
  assert.ok(gateway, 'gateway command exists')
  const exports = gateway.commands.filter((command) => command.name() === 'export')
  assert.equal(exports.length, 1)
  const flags = exports[0]!.options.map((option) => option.long)
  for (const flag of ['--csv', '--output', '--out']) assert.ok(flags.includes(flag), `export has ${flag}`)
})
