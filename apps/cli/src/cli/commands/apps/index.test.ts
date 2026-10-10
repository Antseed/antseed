import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_APP_PROFILES } from '@antseed/connected-apps'

const CLI_INDEX = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.js')

type Workspace = { home: string; dataDir: string; configPath: string; binDir: string }

async function createWorkspace(): Promise<Workspace> {
  const home = await mkdtemp(join(tmpdir(), 'antseed-apps-'))
  const dataDir = join(home, '.antseed')
  const binDir = join(home, 'empty-bin')
  await mkdir(dataDir, { recursive: true })
  await mkdir(binDir, { recursive: true })
  return { home, dataDir, configPath: join(dataDir, 'config.json'), binDir }
}

function run(ws: Workspace, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [CLI_INDEX, '--data-dir', ws.dataDir, '--config', ws.configPath, ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: ws.home,
        USERPROFILE: ws.home,
        // Keep install probes hermetic: no real `codex`/`claude`/… on PATH.
        PATH: ws.binDir,
        XDG_CONFIG_HOME: join(ws.home, '.config'),
      },
    },
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function json<T>(ws: Workspace, args: string[]): T {
  const result = run(ws, [...args, '--json'])
  assert.ok(result.stdout.trim().length > 0, `no JSON output for ${args.join(' ')}: ${result.stderr}`)
  return JSON.parse(result.stdout) as T
}

type StatusReport = {
  schemaVersion: number
  apps: { name: string; displayName: string; installed: boolean; connected: boolean; configPath: string }[]
}
type ActionReport = { schemaVersion: number; ok: boolean; app: string; buyerPort?: number; changed?: boolean; connected?: boolean; error?: string; warnings?: string[] }

function homePath(ws: Workspace, tildePath: string): string {
  return join(ws.home, tildePath.replace(/^~\//, ''))
}

/**
 * A pre-existing user config per app, so disconnect must restore it exactly.
 * Droid and Claude Code replace user values and restore them from their
 * `.antseed.state.json` sidecar, so their originals collide with managed keys
 * on purpose. The other formats remove only what AntSeed added — a value they
 * overwrite (e.g. a top-level codex `model`) is not put back except via the
 * `.antseed.bak` backup, and JSONC comments are not preserved — so their
 * originals avoid managed keys. That is the desktop's existing behaviour.
 */
const ORIGINAL_CONFIGS: Record<string, { path: string; content: string }[]> = {
  opencode: [{ path: '~/.config/opencode/opencode.jsonc', content: '{\n  "theme": "dark",\n  "provider": {}\n}\n' }],
  codex: [{ path: '~/.codex/config.toml', content: 'approval_policy = "on-request"\n\n[profiles.work]\nmodel = "o3"\n' }],
  'claude-code': [{ path: '~/.claude/settings.json', content: '{\n  "model": "opus",\n  "env": {\n    "FOO": "bar",\n    "ANTHROPIC_BASE_URL": "https://example.test"\n  }\n}\n' }],
  hermes: [{ path: '~/.hermes/config.yaml', content: 'display:\n  theme: dark\nproviders:\n  openrouter:\n    api: https://openrouter.ai/api/v1\nmodel:\n  temperature: 1\n' }],
  droid: [{ path: '~/.factory/settings.json', content: '{\n  "model": "claude-opus",\n  "customModels": []\n}\n' }],
  t3code: [{ path: '~/.t3/userdata/settings.json', content: '{\n  "theme": "light"\n}\n' }],
  pi: [
    { path: '~/.pi/agent/models.json', content: '{\n  "providers": {}\n}\n' },
    { path: '~/.pi/agent/settings.json', content: '{\n  "theme": "dark"\n}\n' },
  ],
  'prime-agent': [
    { path: '~/.prime/agent/models.json', content: '{\n  "providers": {}\n}\n' },
    { path: '~/.prime/agent/settings.json', content: '{\n  "theme": "dark"\n}\n' },
  ],
  crush: [{ path: '~/.config/crush/crush.json', content: '{\n  "options": {},\n  "providers": {}\n}\n' }],
  goose: [{ path: '~/.config/goose/config.yaml', content: 'GOOSE_TEMPERATURE: 0.5\n' }],
  zed: [{ path: '~/.config/zed/settings.json', content: '{\n  "ui_font_size": 16\n}\n' }],
}

const DEFAULT_NAMES = DEFAULT_APP_PROFILES.map((profile) => profile['name'] as string)

test('apps status lists every default profile with a versioned schema', async () => {
  const ws = await createWorkspace()
  try {
    const report = json<StatusReport>(ws, ['apps', 'status'])
    assert.equal(report.schemaVersion, 1)
    assert.deepEqual(report.apps.map((app) => app.name), DEFAULT_NAMES)
    for (const app of report.apps) {
      assert.equal(app.connected, false, `${app.name} must start disconnected`)
      assert.equal(typeof app.configPath, 'string')
    }
    // `antseed apps --json` is the same listing.
    assert.deepEqual(json<StatusReport>(ws, ['apps']), report)
    // Human output lists every app too.
    const text = run(ws, ['apps'])
    assert.equal(text.status, 0)
    for (const name of DEFAULT_NAMES) assert.match(text.stdout, new RegExp(`^${name}\\s`, 'm'))
  } finally {
    await rm(ws.home, { recursive: true, force: true })
  }
})

test('apps connect rejects unknown apps and lists the supported ones', async () => {
  const ws = await createWorkspace()
  try {
    const result = run(ws, ['apps', 'connect', 'nope', '--json'])
    assert.equal(result.status, 1)
    const report = JSON.parse(result.stdout) as ActionReport
    assert.equal(report.ok, false)
    assert.match(report.error ?? '', /Supported apps: opencode, codex/)
  } finally {
    await rm(ws.home, { recursive: true, force: true })
  }
})

test('apps connect fails cleanly when an install-probed tool is missing', async () => {
  const ws = await createWorkspace()
  try {
    const result = run(ws, ['apps', 'connect', 'codex', '--json'])
    assert.equal(result.status, 1)
    assert.match((JSON.parse(result.stdout) as ActionReport).error ?? '', /codex was not found/)
    assert.equal(existsSync(join(ws.home, '.codex', 'config.toml')), false)
    assert.equal(existsSync(join(ws.dataDir, 'system-proxy', 'system-proxy.desktop.json')), false)
  } finally {
    await rm(ws.home, { recursive: true, force: true })
  }
})

for (const [name, files] of Object.entries(ORIGINAL_CONFIGS)) {
  test(`apps connect → status → disconnect restores ${name} byte-identically`, async () => {
    const ws = await createWorkspace()
    try {
      for (const file of files) {
        await mkdir(dirname(homePath(ws, file.path)), { recursive: true })
        await writeFile(homePath(ws, file.path), file.content, 'utf8')
      }
      // Desktop state written by an earlier desktop session must survive.
      const statePath = join(ws.dataDir, 'system-proxy', 'system-proxy.desktop.json')
      await mkdir(dirname(statePath), { recursive: true })
      await writeFile(statePath, JSON.stringify({ peerId: 'p', activeProfileNames: ['zz-other'], setupProfileNames: ['zz-other'] }), 'utf8')

      const before = json<StatusReport>(ws, ['apps', 'status']).apps.find((app) => app.name === name)
      assert.equal(before?.installed, true)
      assert.equal(before?.connected, false)

      const connected = json<ActionReport>(ws, ['apps', 'connect', name, '--port', '9123'])
      assert.equal(connected.ok, true, connected.error)
      assert.equal(connected.buyerPort, 9123)
      assert.equal(connected.connected, true)
      const patched = await readFile(homePath(ws, files[0]!.path), 'utf8')
      assert.match(patched, /9123/)
      assert.equal(existsSync(`${homePath(ws, files[0]!.path)}.antseed.bak`), true)

      const after = json<StatusReport>(ws, ['apps', 'status']).apps.find((app) => app.name === name)
      assert.equal(after?.connected, true)
      let state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
      assert.deepEqual(state['activeProfileNames'], ['zz-other', name])
      assert.deepEqual(state['setupProfileNames'], ['zz-other', name])
      assert.equal(state['peerId'], 'p')

      const disconnected = json<ActionReport>(ws, ['apps', 'disconnect', name])
      assert.equal(disconnected.ok, true, disconnected.error)
      assert.equal(disconnected.changed, true)
      assert.equal(disconnected.connected, false)
      for (const file of files) {
        assert.equal(await readFile(homePath(ws, file.path), 'utf8'), file.content, `${file.path} not restored`)
        assert.equal(existsSync(`${homePath(ws, file.path)}.antseed.state.json`), false)
      }
      state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
      assert.deepEqual(state['activeProfileNames'], ['zz-other'])
      assert.deepEqual(state['setupProfileNames'], ['zz-other', name])

      // Second disconnect is a no-op.
      assert.equal(json<ActionReport>(ws, ['apps', 'disconnect', name]).changed, false)
    } finally {
      await rm(ws.home, { recursive: true, force: true })
    }
  })
}

test('apps connect defaults the port from buyer config, then 8377', async () => {
  const ws = await createWorkspace()
  try {
    await mkdir(join(ws.home, '.config', 'zed'), { recursive: true })
    assert.equal(json<ActionReport>(ws, ['apps', 'connect', 'zed']).buyerPort, 8377)
    await writeFile(ws.configPath, JSON.stringify({ buyer: { proxyPort: 8411 } }), 'utf8')
    assert.equal(json<ActionReport>(ws, ['apps', 'connect', 'zed']).buyerPort, 8411)
    await writeFile(join(ws.dataDir, 'buyer.state.json'), JSON.stringify({ port: 8499 }), 'utf8')
    assert.equal(json<ActionReport>(ws, ['apps', 'connect', 'zed']).buyerPort, 8499)
    assert.match(await readFile(join(ws.home, '.config', 'zed', 'settings.json'), 'utf8'), /localhost:8499\/v1/)
  } finally {
    await rm(ws.home, { recursive: true, force: true })
  }
})

test('apps connect creates a missing config and disconnect leaves no AntSeed entry', async () => {
  const ws = await createWorkspace()
  try {
    // Claude Code with no settings.json yet: the .claude dir is the install signal.
    await mkdir(join(ws.home, '.claude'), { recursive: true })
    assert.equal(json<ActionReport>(ws, ['apps', 'connect', 'claude-code']).ok, true)
    assert.equal(existsSync(join(ws.home, '.claude', 'settings.json')), true)
    assert.equal(json<ActionReport>(ws, ['apps', 'disconnect', 'claude-code']).changed, true)
    // Config did not exist before connect, so disconnect removes it again.
    assert.equal(existsSync(join(ws.home, '.claude', 'settings.json')), false)
  } finally {
    await rm(ws.home, { recursive: true, force: true })
  }
})

test('apps connect warns when the buyer has no default route', async () => {
  const ws = await createWorkspace()
  try {
    await mkdir(join(ws.home, '.config', 'zed'), { recursive: true })
    const withoutRoute = json<ActionReport>(ws, ['apps', 'connect', 'zed'])
    assert.equal(withoutRoute.ok, true)
    assert.ok(withoutRoute.warnings?.some((warning) => /no default route/i.test(warning)), JSON.stringify(withoutRoute.warnings))
    await writeFile(join(ws.dataDir, 'buyer.state.json'), JSON.stringify({ port: 8499, defaultRoutedModel: 'claude-sonnet' }), 'utf8')
    const withRoute = json<ActionReport>(ws, ['apps', 'connect', 'zed'])
    assert.equal(withRoute.warnings?.some((warning) => /no default route/i.test(warning)) ?? false, false)
  } finally {
    await rm(ws.home, { recursive: true, force: true })
  }
})
