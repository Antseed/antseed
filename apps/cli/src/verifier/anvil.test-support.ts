import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// Shared by the verifier suites that run against a local Anvil chain.

/** Anvil's default account 0; a public test key. */
export const DEPLOYER_PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
export const contractsDirectory = join(repoRoot, 'packages', 'contracts')

export function deployContract(rpcUrl: string, contract: string, constructorArgs: string[] = []): string {
  const output = runCommand('forge', [
    'create', contract,
    '--rpc-url', rpcUrl,
    '--private-key', `0x${DEPLOYER_PRIVATE_KEY}`,
    '--broadcast',
    ...(constructorArgs.length > 0 ? ['--constructor-args', ...constructorArgs] : []),
  ], contractsDirectory)
  const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/)
  if (!match) throw new Error(`could not parse deployed address for ${contract}:\n${output}`)
  return match[1]!
}

export function castSend(rpcUrl: string, contract: string, signature: string, args: string[]): void {
  runCommand('cast', ['send', '--rpc-url', rpcUrl, '--private-key', `0x${DEPLOYER_PRIVATE_KEY}`, contract, signature, ...args], repoRoot)
}

export function runCommand(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) throw new Error(`command failed: ${command} ${args.join(' ')}\n${output || '(no output)'}`)
  return output
}

export async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not allocate an Anvil port')
  const port = address.port
  server.close()
  await once(server, 'close')
  return port
}

export function startAnvil(port: number): ChildProcessWithoutNullStreams {
  return spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--silent'], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
}

export async function waitForRpcReady(rpcUrl: string, anvil: ChildProcessWithoutNullStreams, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (anvil.exitCode !== null) throw new Error(`Anvil exited before RPC startup with code ${anvil.exitCode}`)
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (response.ok) return
    } catch {
      // Retry until the deadline.
    }
    await sleep(100)
  }
  throw new Error(`Anvil RPC did not start within ${timeoutMs}ms`)
}

export async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(5_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}
