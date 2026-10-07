import assert from 'node:assert/strict'
import { ANTSEED_MODEL_CONTEXT_WINDOW, ANTSEED_MODEL_MAX_OUTPUT_TOKENS } from '@antseed/node/types'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildCodexConfigArgs,
  buildOpenCodeConfigContent,
  normalizeAntseedBaseUrl,
  parseWrappedToolArgs,
  resolveDefaultAntseedBaseUrl,
  resolveWrappedToolProxyToken,
} from './wrapped-tools.js'
import { publishProxyToken } from '../../proxy/proxy-auth.js'

const ROOT_PROXY_URL = 'http://localhost:8378'
const V1_PROXY_URL = `${ROOT_PROXY_URL}/v1`
const MODEL_ID = 'deepseek-v4-flash'
const CLI_INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js')
const RECORDED_ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTSEED_API_KEY', 'OPENCODE_CONFIG'] as const

type OpenCodeConfig = {
  provider: Record<string, {
    options: { baseURL: string }
    models: Record<string, unknown>
  }>
  model: string
}

type ChildCliInvocation = {
  argv: string[]
  env: Record<(typeof RECORDED_ENV_KEYS)[number], string | null>
  opencodeConfig?: OpenCodeConfig
}

type TempWorkspace = {
  binDir: string
  configPath: string
  dataDir: string
}

type RecordingChildCli = {
  readInvocation: () => Promise<ChildCliInvocation>
}

async function withTempWorkspace<T>(fn: (paths: TempWorkspace) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'antseed-wrapper-'))
  try {
    const binDir = join(root, 'bin')
    const dataDir = join(root, 'data')
    await mkdir(binDir)
    await mkdir(dataDir)
    return await fn({ binDir, dataDir, configPath: join(dataDir, 'config.json') })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function createRecordingChildCli(workspace: TempWorkspace, executable: string): Promise<RecordingChildCli> {
  const capturePath = join(workspace.dataDir, `${executable}-invocation.json`)
  const envKeys = JSON.stringify(RECORDED_ENV_KEYS)
  const script = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const envKeys = ${envKeys};
const env = Object.fromEntries(envKeys.map((key) => [key, process.env[key] ?? null]));
const payload = { argv: process.argv.slice(2), env };

if (process.env.OPENCODE_CONFIG) {
  payload.opencodeConfig = JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
}

writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(payload, null, 2));
`
  const executablePath = join(workspace.binDir, executable)
  await writeFile(executablePath, script, 'utf8')
  await chmod(executablePath, 0o755)

  return {
    readInvocation: async () => JSON.parse(await readFile(capturePath, 'utf8')) as ChildCliInvocation,
  }
}

function runWrapper(workspace: TempWorkspace, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [CLI_INDEX, '--data-dir', workspace.dataDir, '--config', workspace.configPath, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${workspace.binDir}:${process.env.PATH ?? ''}` },
    },
  )
}

test('parseWrappedToolArgs', async (t) => {
  await t.test('consumes AntSeed flags and forwards child args', () => {
    const parsed = parseWrappedToolArgs([
      '--model',
      'gpt-oss-120b',
      '--sandbox',
      'workspace-write',
      '--antseed-base-url=localhost:8378',
    ])

    assert.equal(parsed.model, 'gpt-oss-120b')
    assert.equal(parsed.antseedBaseUrl, 'localhost:8378')
    assert.deepEqual(parsed.childArgs, ['--sandbox', 'workspace-write'])
  })

  await t.test('keeps -- escape hatch for child args', () => {
    const parsed = parseWrappedToolArgs(['--model=foo', '--', '--model', 'child-model'])

    assert.equal(parsed.model, 'foo')
    assert.deepEqual(parsed.childArgs, ['--model', 'child-model'])
  })

  await t.test('rejects unsupported AntSeed wrapper flags', () => {
    assert.throws(
      () => parseWrappedToolArgs(['--antseed-peer', 'peer-id']),
      /--antseed-peer is not supported by this wrapper/,
    )
  })
})

test('normalizeAntseedBaseUrl', async (t) => {
  await t.test('adds protocol and /v1 to a root URL', () => {
    assert.deepEqual(normalizeAntseedBaseUrl('localhost:8377'), {
      root: 'http://localhost:8377',
      v1: 'http://localhost:8377/v1',
    })
  })

  await t.test('derives root from a /v1 URL', () => {
    assert.deepEqual(normalizeAntseedBaseUrl('http://localhost:8377/v1'), {
      root: 'http://localhost:8377',
      v1: 'http://localhost:8377/v1',
    })
  })
})

test('resolveDefaultAntseedBaseUrl prefers active buyer state over config', async () => {
  await withTempWorkspace(async ({ dataDir, configPath }) => {
    await writeFile(configPath, JSON.stringify({ buyer: { proxyPort: 8390 } }))
    assert.equal(await resolveDefaultAntseedBaseUrl(dataDir, configPath), 'http://localhost:8390')

    await writeFile(join(dataDir, 'buyer.state.json'), JSON.stringify({ port: 8378 }))
    assert.equal(await resolveDefaultAntseedBaseUrl(dataDir, configPath), 'http://localhost:8378')
  })
})

test('resolveWrappedToolProxyToken uses the local daemon token file, or ANTSEED_PROXY_TOKEN for a remote buyer', async () => {
  await withTempWorkspace(async ({ dataDir }) => {
    assert.equal(resolveWrappedToolProxyToken('http://localhost:8378', dataDir, {}), null)
    await publishProxyToken(dataDir, 8378, 'local-token-0123456789')
    assert.equal(resolveWrappedToolProxyToken('http://localhost:8378', dataDir, {}), 'local-token-0123456789')
    assert.equal(resolveWrappedToolProxyToken('http://127.0.0.1:8378/v1', dataDir, {}), 'local-token-0123456789')
    assert.equal(resolveWrappedToolProxyToken('http://buyer.internal:8378', dataDir, {}), null)
    assert.equal(
      resolveWrappedToolProxyToken('http://buyer.internal:8378', dataDir, { ANTSEED_PROXY_TOKEN: 'remote-token-0123456789' }),
      'remote-token-0123456789',
    )
  })
})

test('buildOpenCodeConfigContent uses the proxy token as the API key when given', () => {
  const config = JSON.parse(buildOpenCodeConfigContent(V1_PROXY_URL, MODEL_ID, 'proxy-token-0123456789')) as {
    provider: { antseed: { options: { apiKey: string } } }
  }
  assert.equal(config.provider.antseed.options.apiKey, 'proxy-token-0123456789')
})

test('buildCodexConfigArgs uses ephemeral config overrides on the real Codex home', () => {
  const args = buildCodexConfigArgs(V1_PROXY_URL, MODEL_ID)

  assert.equal(args.includes('--profile'), false)
  assert.equal(args.includes('CODEX_HOME'), false)
  assert.ok(args.includes('model_providers.antseed.name="AntSeed"'))
  assert.ok(args.includes(`model_providers.antseed.base_url="${V1_PROXY_URL}"`))
  assert.ok(args.includes('model_providers.antseed.wire_api="responses"'))
  assert.ok(args.includes('model_providers.antseed.env_key="ANTSEED_API_KEY"'))
  assert.ok(args.includes(`model="${MODEL_ID}"`))
  assert.ok(args.includes('model_provider="antseed"'))
  assert.ok(args.includes(`model_context_window=${ANTSEED_MODEL_CONTEXT_WINDOW}`))
})

test('buildOpenCodeConfigContent configures AntSeed provider and selected model', () => {
  const model = 'gpt-oss-120b'
  const parsed = JSON.parse(buildOpenCodeConfigContent(V1_PROXY_URL, model)) as OpenCodeConfig

  assert.ok(parsed.provider.antseed)
  assert.equal(parsed.provider.antseed.options.baseURL, V1_PROXY_URL)
  assert.equal(parsed.model, `antseed/${model}`)
  assert.deepEqual(parsed.provider.antseed.models[model], {
    name: `${model} (via AntSeed)`,
    limit: { context: ANTSEED_MODEL_CONTEXT_WINDOW, output: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
  })
})

test('wrapped tool execution', async (t) => {
  await t.test('codex receives AntSeed config overrides and forwarded child args', async () => {
    await withTempWorkspace(async (workspace) => {
      const codex = await createRecordingChildCli(workspace, 'codex')

      const result = runWrapper(workspace, [
        'codex',
        '--model',
        'minimax-m2.5',
        '--antseed-base-url',
        'localhost:8125',
        '--',
        '--version',
      ])
      const invocation = await codex.readInvocation()

      assert.equal(result.status, 0)
      assert.equal(String(result.stderr), '')
      assert.match(String(result.stdout), /AntSeed proxy: http:\/\/localhost:8125\/v1/)
      assert.ok(invocation.argv.includes('model_provider="antseed"'))
      assert.equal(invocation.argv.at(-1), '--version')
      assert.equal(invocation.env.ANTSEED_API_KEY, 'antseed')
    })
  })

  await t.test('claude receives Anthropic proxy env and model args', async () => {
    await withTempWorkspace(async (workspace) => {
      const claude = await createRecordingChildCli(workspace, 'claude')

      const result = runWrapper(workspace, [
        'claude',
        '--model',
        'claude-sonnet',
        '--antseed-base-url',
        'localhost:8123/v1',
        '--print',
      ])
      const invocation = await claude.readInvocation()

      assert.equal(result.status, 0)
      assert.equal(String(result.stderr), '')
      assert.match(String(result.stdout), /AntSeed proxy: http:\/\/localhost:8123/)
      assert.deepEqual(invocation.argv, ['--model', 'claude-sonnet', '--print'])
      assert.equal(invocation.env.ANTHROPIC_BASE_URL, 'http://localhost:8123')
      assert.equal(invocation.env.ANTHROPIC_API_KEY, 'antseed')
    })
  })

  await t.test('opencode receives generated config and forwarded child args', async () => {
    await withTempWorkspace(async (workspace) => {
      const opencode = await createRecordingChildCli(workspace, 'opencode')

      const result = runWrapper(workspace, [
        'opencode',
        '--model',
        'gpt-oss-120b',
        '--antseed-base-url',
        'http://localhost:8124/v1',
        'run',
      ])
      const invocation = await opencode.readInvocation()
      const antseedProvider = invocation.opencodeConfig?.provider.antseed

      assert.equal(result.status, 0)
      assert.equal(String(result.stderr), '')
      assert.match(String(result.stdout), /AntSeed proxy: http:\/\/localhost:8124\/v1/)
      assert.deepEqual(invocation.argv, ['run'])
      assert.equal(invocation.opencodeConfig?.model, 'antseed/gpt-oss-120b')
      assert.ok(antseedProvider)
      assert.equal(antseedProvider.options.baseURL, 'http://localhost:8124/v1')
      assert.ok(antseedProvider.models['gpt-oss-120b'])
    })
  })
})
