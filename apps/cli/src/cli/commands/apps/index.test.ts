import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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

function runAsync(ws: Workspace, args: string[]): Promise<ActionReport> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_INDEX, '--data-dir', ws.dataDir, '--config', ws.configPath, ...args, '--json'],
      { env: { ...process.env, HOME: ws.home, USERPROFILE: ws.home, PATH: ws.binDir, XDG_CONFIG_HOME: join(ws.home, '.config') } },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', () => {
      try {
        resolvePromise(JSON.parse(stdout) as ActionReport)
      } catch {
        reject(new Error(`no JSON output for ${args.join(' ')}: ${stderr}`))
      }
    })
  })
}

async function startFakeBuyer(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return { server, port: (server.address() as AddressInfo).port }
}

const CATALOG_APPS: { name: string; dir: string; read: (ws: Workspace) => Promise<string[]> }[] = [
  {
    name: 'codex',
    dir: '~/.codex',
    read: async (ws) => (JSON.parse(await readFile(join(ws.home, '.codex', 'config.toml.antseed.models.json'), 'utf8')) as { models: { slug: string }[] }).models.map((model) => model.slug),
  },
  {
    name: 'droid',
    dir: '~/.factory',
    read: async (ws) => (JSON.parse(await readFile(join(ws.home, '.factory', 'settings.json'), 'utf8')) as { customModels: { id: string; model: string }[] }).customModels
      .filter((model) => model.id.startsWith('custom:Antseed-'))
      .map((model) => model.model),
  },
  {
    name: 'pi',
    dir: '~/.pi/agent',
    read: async (ws) => (JSON.parse(await readFile(join(ws.home, '.pi', 'agent', 'models.json'), 'utf8')) as { providers: { antseed: { models: { id: string }[] } } }).providers.antseed.models.map((model) => model.id),
  },
  {
    name: 'prime-agent',
    dir: '~/.prime/agent',
    read: async (ws) => (JSON.parse(await readFile(join(ws.home, '.prime', 'agent', 'models.json'), 'utf8')) as { providers: { antseed: { models: { id: string }[] } } }).providers.antseed.models.map((model) => model.id),
  },
  {
    name: 'opencode',
    dir: '~/.config/opencode',
    read: async (ws) => Object.keys((JSON.parse(await readFile(join(ws.home, '.config', 'opencode', 'opencode.jsonc'), 'utf8')) as { provider: { antseed: { models: Record<string, unknown> } } }).provider.antseed.models),
  },
  {
    name: 'crush',
    dir: '~/.config/crush',
    read: async (ws) => (JSON.parse(await readFile(join(ws.home, '.config', 'crush', 'crush.json'), 'utf8')) as { providers: { antseed: { models: { id: string }[] } } }).providers.antseed.models.map((model) => model.id),
  },
  {
    name: 'zed',
    dir: '~/.config/zed',
    read: async (ws) => (JSON.parse(await readFile(join(ws.home, '.config', 'zed', 'settings.json'), 'utf8')) as { language_models: { openai_compatible: { Antseed: { available_models: { name: string }[] } } } }).language_models.openai_compatible.Antseed.available_models.map((model) => model.name),
  },
  {
    name: 'hermes',
    dir: '~/.hermes',
    read: async (ws) => [...(await readFile(join(ws.home, '.hermes', 'config.yaml'), 'utf8')).matchAll(/([\w.-]+):\s*\{?\s*context_length:/g)].map((match) => match[1]!),
  },
  {
    name: 't3code',
    dir: '~/.t3/userdata',
    read: async (ws) => (JSON.parse(await readFile(join(ws.home, '.t3', 'userdata', 'settings.json'), 'utf8')) as { providerInstances: { antseed: { config: { customModels: string[] } } } }).providerInstances.antseed.config.customModels,
  },
]

test('apps connect writes the curated Recommended lineup into every in-app model picker', async () => {
  const requests: string[] = []
  const { server, port } = await startFakeBuyer((req, res) => {
    requests.push(req.url ?? '')
    res.setHeader('content-type', 'application/json')
    // The buyer lists every network model; connect writes only the curated
    // Recommended lineup the desktop picker offers (aion-2.0 is not in it).
    res.end(JSON.stringify({ object: 'list', data: [
      { id: 'aion-2.0', name: 'Aion 2.0', type: 'text', peers: [{ peerId: 'p1' }, { peerId: 'p2' }, { peerId: 'p3' }] },
      { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', type: 'text', peers: [{ peerId: 'p1', capabilities: { reasoning: false } }] },
      { id: 'claude-opus-5', name: 'Claude Opus 5', type: 'text', peers: [{ peerId: 'p1', capabilities: {} }, { peerId: 'p2', capabilities: { reasoning: true } }] },
    ] }))
  })
  const ws = await createWorkspace()
  try {
    for (const app of CATALOG_APPS) {
      await mkdir(homePath(ws, app.dir), { recursive: true })
      const connected = await runAsync(ws, ['apps', 'connect', app.name, '--port', String(port)])
      assert.equal(connected.ok, true, connected.error)
      assert.deepEqual(await app.read(ws), ['antseed', 'claude-opus-5', 'gpt-5.6-sol'], app.name)
      if (app.name === 'codex') {
        const catalog = JSON.parse(await readFile(join(ws.home, '.codex', 'config.toml.antseed.models.json'), 'utf8')) as { models: { slug: string; supported_reasoning_levels: unknown[] }[] }
        assert.deepEqual(catalog.models.map((model) => [model.slug, model.supported_reasoning_levels.length > 0]), [['antseed', true], ['claude-opus-5', true], ['gpt-5.6-sol', false]])
      }
      const disconnected = await runAsync(ws, ['apps', 'disconnect', app.name])
      assert.equal(disconnected.ok, true, disconnected.error)
      assert.equal(json<StatusReport>(ws, ['apps', 'status']).apps.find((entry) => entry.name === app.name)?.connected, false, app.name)
    }
    assert.equal(existsSync(join(ws.home, '.codex', 'config.toml.antseed.models.json')), false)
    assert.ok(requests.length >= CATALOG_APPS.length)
    assert.ok(requests.every((url) => url === '/v1/models?type=text'), requests.join(', '))
  } finally {
    server.close()
    await rm(ws.home, { recursive: true, force: true })
  }
})

test('apps connect lists the AI VPN selection and starred models before the lineup', async () => {
  const { server, port } = await startFakeBuyer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: [
      { id: 'claude-opus-5', name: 'Claude Opus 5', type: 'text', peers: [{ peerId: 'p1' }] },
      { id: 'aion-2.0', name: 'Aion 2.0', type: 'text', peers: [{ peerId: 'p1' }] },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', type: 'text', peers: [{ peerId: 'p1' }] },
      { id: 'blocked-only', name: 'Blocked', type: 'text', peers: [{ peerId: '0x' + 'b'.repeat(40) }] },
    ] }))
  })
  const ws = await createWorkspace()
  try {
    await writeFile(ws.configPath, JSON.stringify({ buyer: {
      favoriteModels: ['aion20', 'blockedonly'],
      routingPreferences: { blockedPeerIds: ['0x' + 'b'.repeat(40)] },
    } }), 'utf8')
    await writeFile(join(ws.dataDir, 'buyer.state.json'), JSON.stringify({ defaultRoutedModel: `${'a'.repeat(40)}@kimi-k2.6` }), 'utf8')
    await mkdir(homePath(ws, '~/.pi/agent'), { recursive: true })
    const connected = await runAsync(ws, ['apps', 'connect', 'pi', '--port', String(port)])
    assert.equal(connected.ok, true, connected.error)
    const pi = JSON.parse(await readFile(join(ws.home, '.pi', 'agent', 'models.json'), 'utf8')) as { providers: { antseed: { models: { id: string }[] } } }
    assert.deepEqual(pi.providers.antseed.models.map((model) => model.id), ['antseed', 'kimi-k2.6', 'aion-2.0', 'claude-opus-5'])
  } finally {
    server.close()
    await rm(ws.home, { recursive: true, force: true })
  }
})

test('apps connect falls back to Antseed Auto when the buyer model list is unavailable', async () => {
  const { server, port } = await startFakeBuyer((_req, res) => {
    res.statusCode = 503
    res.end('unavailable')
  })
  const ws = await createWorkspace()
  try {
    for (const app of CATALOG_APPS) {
      await mkdir(homePath(ws, app.dir), { recursive: true })
      const connected = await runAsync(ws, ['apps', 'connect', app.name, '--port', String(port)])
      assert.equal(connected.ok, true, connected.error)
      assert.deepEqual(await app.read(ws), ['antseed'], app.name)
    }
  } finally {
    server.close()
    await rm(ws.home, { recursive: true, force: true })
  }
})

test('apps connect points Claude Desktop at the buyer route and disconnect restores it', async () => {
  const ws = await createWorkspace()
  try {
    const normalConfig = join(ws.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    const original = '{\n  "mcpServers": {}\n}\n'
    await mkdir(dirname(normalConfig), { recursive: true })
    await writeFile(normalConfig, original, 'utf8')

    const connected = json<ActionReport>(ws, ['apps', 'connect', 'claude-desktop', '--port', '9123'])
    assert.equal(connected.ok, true, connected.error)
    assert.equal(connected.connected, true)
    const profilePath = join(ws.home, 'Library', 'Application Support', 'Claude-3p', 'configLibrary', '00000000-0000-4000-8000-0000a4753eed.json')
    const profile = JSON.parse(await readFile(profilePath, 'utf8')) as Record<string, unknown>
    assert.equal(profile['inferenceGatewayBaseUrl'], 'http://127.0.0.1:9123/claude-desktop')

    const disconnected = json<ActionReport>(ws, ['apps', 'disconnect', 'claude-desktop'])
    assert.equal(disconnected.changed, true)
    assert.equal(disconnected.connected, false)
    assert.equal((JSON.parse(await readFile(normalConfig, 'utf8')) as Record<string, unknown>)['deploymentMode'], '1p')
  } finally {
    await rm(ws.home, { recursive: true, force: true })
  }
})

test('buyer connection set --model sets the default route connected apps use', async () => {
  const ws = await createWorkspace()
  try {
    const statePath = join(ws.dataDir, 'buyer.state.json')
    await writeFile(statePath, JSON.stringify({ state: 'connected', pid: process.pid, port: 8499, pinnedPeerId: null }), 'utf8')
    assert.equal(run(ws, ['buyer', 'connection', 'set', '--model', 'antseed']).status, 1)
    assert.equal(run(ws, ['buyer', 'connection', 'set', '--model', 'kimi-k3']).status, 0)
    assert.equal((JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>)['defaultRoutedModel'], 'kimi-k3')

    await mkdir(join(ws.home, '.config', 'zed'), { recursive: true })
    assert.equal(json<ActionReport>(ws, ['apps', 'connect', 'zed']).warnings, undefined)

    assert.equal(run(ws, ['buyer', 'connection', 'clear']).status, 0)
    assert.equal((JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>)['defaultRoutedModel'], null)
  } finally {
    await rm(ws.home, { recursive: true, force: true })
  }
})
