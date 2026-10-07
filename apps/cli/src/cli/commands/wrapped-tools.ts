import type { Command } from 'commander'
import chalk from 'chalk'
import { ANTSEED_MODEL_CONTEXT_WINDOW, ANTSEED_MODEL_MAX_OUTPUT_TOKENS } from '@antseed/node/types'
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { getGlobalOptions } from './types.js'
import { PROXY_TOKEN_ENV, isLoopbackHost, readProxyToken } from '../../proxy/proxy-auth.js'

type ToolName = 'codex' | 'claude' | 'opencode'

type ToolConfig = {
  executable: string
}

const DEFAULT_PROXY_ROOT_URL = 'http://localhost:8377'
const DEFAULT_RUNTIME_API_KEY = 'antseed'
const OPENCODE_CONFIG_PREFIX = 'antseed-opencode-'

const TOOL_CONFIGS: Record<ToolName, ToolConfig> = {
  codex: {
    executable: 'codex',
  },
  claude: {
    executable: 'claude',
  },
  opencode: {
    executable: 'opencode',
  },
}

const NOOP_CLEANUP = async (): Promise<void> => {}

export type ParsedWrappedToolArgs = {
  childArgs: string[]
  model: string | null
  antseedBaseUrl: string | null
}

type NormalizedBaseUrl = {
  root: string
  v1: string
}

/**
 * Bearer token for the buyer proxy at `baseUrl`, when it requires one. A
 * local buyer publishes its token in the data dir; a remote one is reached
 * with ANTSEED_PROXY_TOKEN.
 */
export function resolveWrappedToolProxyToken(baseUrl: string, dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const url = new URL(baseUrl)
  if (isLoopbackHost(url.hostname)) {
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
    return readProxyToken(dataDir, port)
  }
  return env[PROXY_TOKEN_ENV]?.trim() || null
}

type PreparedInvocation = {
  args: string[]
  env: NodeJS.ProcessEnv
  cleanup: () => Promise<void>
}

export function parseWrappedToolArgs(rawArgs: string[]): ParsedWrappedToolArgs {
  const childArgs: string[] = []
  let model: string | null = null
  let antseedBaseUrl: string | null = null

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i]!
    if (arg === '--') {
      childArgs.push(...rawArgs.slice(i + 1))
      break
    }

    const modelFlag = readValueFlag(rawArgs, i, '--model')
    if (modelFlag) {
      model = modelFlag.value
      i = modelFlag.nextIndex
      continue
    }

    const baseUrlFlag = readValueFlag(rawArgs, i, '--antseed-base-url')
    if (baseUrlFlag) {
      antseedBaseUrl = baseUrlFlag.value
      i = baseUrlFlag.nextIndex
      continue
    }

    if (arg.startsWith('--antseed-')) {
      throw new Error(`${arg.split('=')[0]} is not supported by this wrapper`)
    }

    childArgs.push(arg)
  }

  return {
    childArgs,
    model: normalizeOptionalString(model),
    antseedBaseUrl: normalizeOptionalString(antseedBaseUrl),
  }
}

function readValueFlag(args: string[], index: number, flag: string): { value: string; nextIndex: number } | null {
  const arg = args[index]!
  const inlineValue = readInlineValue(arg, flag)
  if (inlineValue !== null) {
    return { value: inlineValue, nextIndex: index }
  }
  if (arg !== flag) {
    return null
  }

  const value = args[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} requires a value`)
  }
  return { value, nextIndex: index + 1 }
}

function readInlineValue(arg: string, flag: string): string | null {
  const prefix = `${flag}=`
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : null
}

export function normalizeAntseedBaseUrl(inputUrl: string | null | undefined): NormalizedBaseUrl {
  const raw = normalizeOptionalString(inputUrl) ?? DEFAULT_PROXY_ROOT_URL
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  const parsed = new URL(withProtocol)
  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')

  const path = parsed.pathname === '/' ? '' : parsed.pathname
  if (path.toLowerCase() === '/v1') {
    parsed.pathname = ''
    const root = parsed.toString().replace(/\/$/, '')
    return { root, v1: `${root}/v1` }
  }

  const root = parsed.toString().replace(/\/$/, '')
  return { root, v1: `${root}/v1` }
}

export async function resolveDefaultAntseedBaseUrl(dataDir: string, configPath: string): Promise<string> {
  const statePort = await readJsonPort(join(dataDir, 'buyer.state.json'), ['port'])
  if (statePort !== null) {
    return `http://localhost:${statePort}`
  }

  const configuredPort = await readJsonPort(configPath, ['buyer', 'proxyPort'])
  if (configuredPort !== null) {
    return `http://localhost:${configuredPort}`
  }

  return DEFAULT_PROXY_ROOT_URL
}

export function buildCodexConfigArgs(baseUrlV1: string, model: string): string[] {
  return [
    '-c',
    `model_providers.antseed.name=${tomlString('AntSeed')}`,
    '-c',
    `model_providers.antseed.base_url=${tomlString(baseUrlV1)}`,
    '-c',
    'model_providers.antseed.wire_api="responses"',
    '-c',
    'model_providers.antseed.env_key="ANTSEED_API_KEY"',
    '-c',
    `model_providers.antseed.env_key_instructions=${tomlString('The AntSeed wrapper sets ANTSEED_API_KEY automatically.')}`,
    '-c',
    `model=${tomlString(model)}`,
    '-c',
    'model_provider="antseed"',
    '-c',
    `model_context_window=${ANTSEED_MODEL_CONTEXT_WINDOW}`,
  ]
}

export function buildOpenCodeConfigContent(baseUrlV1: string, model: string, apiKey: string = DEFAULT_RUNTIME_API_KEY): string {
  return JSON.stringify({
    provider: {
      antseed: {
        npm: '@ai-sdk/openai-compatible',
        name: 'AntSeed',
        options: {
          baseURL: baseUrlV1,
          apiKey,
        },
        models: {
          [model]: {
            name: `${model} (via AntSeed)`,
            limit: {
              context: ANTSEED_MODEL_CONTEXT_WINDOW,
              output: ANTSEED_MODEL_MAX_OUTPUT_TOKENS,
            },
          },
        },
      },
    },
    model: `antseed/${model}`,
  })
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function readJsonPort(filePath: string, path: string[]): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as unknown
    let current: unknown = parsed
    for (const key of path) {
      if (typeof current !== 'object' || current === null || !(key in current)) {
        return null
      }
      current = (current as Record<string, unknown>)[key]
    }
    const port = Number(current)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

function resolveModel(model: string | null, toolName: ToolName): string {
  const resolved = normalizeOptionalString(model) ?? normalizeOptionalString(process.env['ANTSEED_MODEL'])
  if (resolved) return resolved
  throw new Error(`${toolName} requires --model <service-id> or ANTSEED_MODEL`)
}

function resolveExecutable(command: string): string | null {
  if (command.includes('/') || command.includes('\\')) {
    return command
  }
  const pathEnv = process.env['PATH'] ?? ''
  const extensions = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // try next candidate
      }
    }
  }
  return null
}

async function spawnInteractive(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return await new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (typeof code === 'number') {
        resolveExit(code)
      } else {
        console.log(chalk.yellow(`Child process exited from signal ${signal ?? 'unknown'}.`))
        resolveExit(1)
      }
    })
  })
}

async function prepareToolInvocation(
  toolName: ToolName,
  parsed: ParsedWrappedToolArgs,
  baseUrl: NormalizedBaseUrl,
  proxyToken: string | null,
): Promise<PreparedInvocation> {
  switch (toolName) {
    case 'codex':
      return prepareCodexInvocation(parsed, baseUrl, proxyToken)
    case 'claude':
      return prepareClaudeInvocation(parsed, baseUrl, proxyToken)
    case 'opencode':
      return await prepareOpenCodeInvocation(parsed, baseUrl, proxyToken)
  }
}

function prepareCodexInvocation(parsed: ParsedWrappedToolArgs, baseUrl: NormalizedBaseUrl, proxyToken: string | null): PreparedInvocation {
  const model = resolveModel(parsed.model, 'codex')
  return {
    args: [...buildCodexConfigArgs(baseUrl.v1, model), ...parsed.childArgs],
    // Codex sends ANTSEED_API_KEY as `Authorization: Bearer`.
    env: proxyToken
      ? { ...process.env, ANTSEED_API_KEY: proxyToken }
      : withDefaultEnv('ANTSEED_API_KEY', DEFAULT_RUNTIME_API_KEY),
    cleanup: NOOP_CLEANUP,
  }
}

function prepareClaudeInvocation(parsed: ParsedWrappedToolArgs, baseUrl: NormalizedBaseUrl, proxyToken: string | null): PreparedInvocation {
  return {
    args: parsed.model ? ['--model', parsed.model, ...parsed.childArgs] : parsed.childArgs,
    env: {
      ...withDefaultEnv('ANTHROPIC_API_KEY', DEFAULT_RUNTIME_API_KEY),
      // Claude Code sends ANTHROPIC_AUTH_TOKEN as `Authorization: Bearer`
      // (ANTHROPIC_API_KEY goes out as x-api-key, which the proxy never uses).
      ...(proxyToken ? { ANTHROPIC_AUTH_TOKEN: proxyToken } : {}),
      ANTHROPIC_BASE_URL: baseUrl.root,
    },
    cleanup: NOOP_CLEANUP,
  }
}

async function prepareOpenCodeInvocation(parsed: ParsedWrappedToolArgs, baseUrl: NormalizedBaseUrl, proxyToken: string | null): Promise<PreparedInvocation> {
  const model = resolveModel(parsed.model, 'opencode')
  const configDir = await mkdtemp(join(tmpdir(), OPENCODE_CONFIG_PREFIX))
  const configPath = join(configDir, 'opencode.json')
  await writeFile(configPath, buildOpenCodeConfigContent(baseUrl.v1, model, proxyToken ?? DEFAULT_RUNTIME_API_KEY), { encoding: 'utf-8', mode: 0o600 })
  return {
    args: parsed.childArgs,
    env: {
      ...process.env,
      OPENCODE_CONFIG: configPath,
    },
    cleanup: () => rm(configDir, { recursive: true, force: true }),
  }
}

function withDefaultEnv(name: string, fallback: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [name]: process.env[name] || fallback,
  }
}

function proxyDisplayUrl(toolName: ToolName, baseUrl: NormalizedBaseUrl): string {
  return toolName === 'claude' ? baseUrl.root : baseUrl.v1
}

async function runWrappedTool(toolName: ToolName, rawArgs: string[], dataDir: string, configPath: string): Promise<void> {
  const tool = TOOL_CONFIGS[toolName]
  let parsed: ParsedWrappedToolArgs
  let baseUrl: NormalizedBaseUrl
  let prepared: PreparedInvocation
  try {
    parsed = parseWrappedToolArgs(rawArgs)
    baseUrl = normalizeAntseedBaseUrl(parsed.antseedBaseUrl ?? await resolveDefaultAntseedBaseUrl(dataDir, configPath))
    prepared = await prepareToolInvocation(toolName, parsed, baseUrl, resolveWrappedToolProxyToken(baseUrl.root, dataDir))
  } catch (err) {
    console.error(chalk.red((err as Error).message))
    process.exitCode = 1
    return
  }

  const executable = resolveExecutable(tool.executable)
  if (!executable) {
    console.error(chalk.red(`"${tool.executable}" is not installed or is not on PATH.`))
    process.exit(1)
  }

  console.log(chalk.dim(`AntSeed proxy: ${proxyDisplayUrl(toolName, baseUrl)}`))
  const exitCode = await spawnInteractive(executable, prepared.args, prepared.env).catch((err) => {
    console.error(chalk.red(`Failed to run ${toolName}: ${(err as Error).message}`))
    return 1
  }).finally(async () => {
    await prepared.cleanup().catch(() => {})
  })
  process.exitCode = exitCode
}

function registerToolCommand(program: Command, toolName: ToolName): void {
  const tool = TOOL_CONFIGS[toolName]
  program
    .command(toolName)
    .description(`Run ${tool.executable} with AntSeed proxy settings`)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]', `${tool.executable} arguments; AntSeed consumes --model and --antseed-base-url`)
    .addHelpText('after', `

AntSeed wrapper flags:
  --model <service-id>             Service/model id for the tool
  --antseed-base-url <url>         Proxy URL (default: active buyer proxy/config)

Unknown flags are forwarded to ${tool.executable}.
`)
    .action(async (args: string[]) => {
      const globalOpts = getGlobalOptions(program)
      await runWrappedTool(toolName, args, globalOpts.dataDir, globalOpts.config)
    })
}

export function registerWrappedToolCommands(program: Command): void {
  registerToolCommand(program, 'codex')
  registerToolCommand(program, 'claude')
  registerToolCommand(program, 'opencode')
}
