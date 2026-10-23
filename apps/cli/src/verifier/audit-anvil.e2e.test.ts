import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Wallet, getAddress } from 'ethers'
import { VERIFIER_VERDICT, VerifierClient, modelHash } from '@antseed/node/payments'
import {
  FIXTURE_CONFIG,
  referenceFixture,
  writeSignedAuditRun,
  type FixtureAudit,
} from './model-audit-fixtures.test-support.js'

const randomWallet = (): Wallet => new Wallet(Wallet.createRandom().privateKey)
const RUN_ANVIL_E2E = process.env['ANTSEED_RUN_VERIFIER_ANVIL_E2E'] === '1'
const DEPLOYER_PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const AUDITOR_PRIVATE_KEY = '8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'
const UNAPPROVED_PRIVATE_KEY = '92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e'
const AUDIT_EPOCH = 5
const SELLER_OWNERS = [
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
] as const
const RUN_ID = 'anvil-audit-run'
const EPOCH = String(AUDIT_EPOCH)
/** Puts epoch AUDIT_EPOCH on 2026-10-07 (UTC), where the fixture run's timestamps fall. */
const EPOCH_DURATION = 86_400
const GENESIS = Date.parse('2026-10-07T00:00:00.000Z') / 1_000 - AUDIT_EPOCH * EPOCH_DURATION

const compiledTestDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(compiledTestDirectory, '../../../..')
const contractsDirectory = join(repoRoot, 'packages', 'contracts')
const cliEntry = join(repoRoot, 'apps', 'cli', 'dist', 'cli', 'index.js')

interface CommandResult {
  status: number
  output: string
}

interface RunCliOptions {
  env?: NodeJS.ProcessEnv
  importPath?: string
}

test('an approved auditor submits one audit per model, earns credits, and a re-run is a no-op', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-audit-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const anvil = startAnvil(port)
  try {
    await waitForRpcReady(rpcUrl, anvil)
    const registryAddress = deployContract(rpcUrl, 'core/AntseedRegistry.sol:AntseedRegistry')
    const identityRegistryAddress = deployContract(rpcUrl, 'test/mocks/MockERC8004Registry.sol:MockERC8004Registry')
    const gateAddress = deployContract(rpcUrl, 'test/mocks/MockVerificationEmissionsGate.sol:MockVerificationEmissionsGate')
    const poolsAddress = deployContract(rpcUrl, 'test/mocks/MockVerificationSellerPools.sol:MockVerificationSellerPools')
    castSend(rpcUrl, registryAddress, 'setIdentityRegistry(address)', [identityRegistryAddress])
    castSend(rpcUrl, registryAddress, 'setEmissions(address)', [gateAddress])
    // The constructor pins the gate behind `registry.emissions()`, so wire the registry first.
    const verificationAddress = deployContract(
      rpcUrl,
      'verification/AntseedVerification.sol:AntseedVerification',
      [registryAddress, poolsAddress],
    )
    castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH)])
    castSend(rpcUrl, gateAddress, 'setSchedule(uint256,uint256)', [String(GENESIS), String(EPOCH_DURATION)])
    const auditor = new Wallet(`0x${AUDITOR_PRIVATE_KEY}`)
    castSend(rpcUrl, verificationAddress, 'setAuditor(address,bool)', [auditor.address, 'true'])
    // Agent 3 belongs to the auditor, who must not audit it.
    const owners = [...SELLER_OWNERS, auditor.address]
    for (const [index, owner] of owners.entries()) {
      castSend(rpcUrl, identityRegistryAddress, 'setOwner(uint256,address)', [String(index + 1), owner])
    }
    castSend(rpcUrl, poolsAddress, 'setPower(uint256,uint256,uint256)', ['1', String(AUDIT_EPOCH), '300'])
    castSend(rpcUrl, poolsAddress, 'setPower(uint256,uint256,uint256)', ['2', String(AUDIT_EPOCH), '100'])

    const sellers = [randomWallet(), randomWallet(), randomWallet()]
    const audits: FixtureAudit[] = [
      { agentId: '1', seller: sellers[0]!, model: 'model-a', service: 'model-a', verdict: 'SAME', reference: referenceFixture('model-a') },
      { agentId: '1', seller: sellers[0]!, model: 'model-b', service: 'model-b', verdict: 'SAME', reference: referenceFixture('model-b') },
      { agentId: '2', seller: sellers[1]!, model: 'model-a', service: 'model-a', verdict: 'DIFF', reference: referenceFixture('model-a') },
      { agentId: '2', seller: sellers[1]!, model: 'model-b', service: 'model-b', verdict: 'UNDETERMINED', reference: referenceFixture('model-b') },
      { agentId: '3', seller: sellers[2]!, model: 'model-b', service: 'model-b', verdict: 'SAME', reference: referenceFixture('model-b') },
    ]
    const crypto = {
      chainId: 'base-local',
      rpcUrl,
      verificationContractAddress: verificationAddress,
      verificationDeployBlock: 0,
      identityRegistryAddress,
    }
    const setUpDataDir = async (name: string, key: string) => {
      const dataDir = join(directory, name)
      const evidenceDir = join(dataDir, 'verifier', 'evidence')
      const banksDir = join(dataDir, 'verifier', 'banks')
      const configPath = join(dataDir, 'config.json')
      await mkdir(dataDir, { recursive: true })
      await writeFile(join(dataDir, 'identity.key'), `${key}\n`, { mode: 0o600 })
      await writeFile(configPath, JSON.stringify({
        payments: { preferredMethod: 'crypto', crypto },
        verifier: { evidenceDir, banksDir, ...FIXTURE_CONFIG },
      }))
      await writeSignedAuditRun({ evidenceDir, banksDir, runId: RUN_ID, epoch: EPOCH, auditor: new Wallet(`0x${key}`), audits })
      return { dataDir, configPath, evidenceDir }
    }
    const approved = await setUpDataDir('auditor', AUDITOR_PRIVATE_KEY)
    const unapproved = await setUpDataDir('unapproved', UNAPPROVED_PRIVATE_KEY)

    const pinataLogPath = join(directory, 'pinata-uploads.jsonl')
    const pinataPreloadPath = join(directory, 'mock-pinata.mjs')
    await writeMockPinataPreload(pinataPreloadPath, pinataLogPath)
    const submit = (dirs: typeof approved, extra: string[]) => runCli(dirs.dataDir, dirs.configPath, rpcUrl, [
      'submit', '--run-id', RUN_ID, ...extra,
    ], { importPath: pinataPreloadPath, env: { PINATA_JWT: 'test-pinata-jwt' } })
    const client = new VerifierClient({ rpcUrl, contractAddress: verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })

    const dryRun = submit(approved, ['--dry-run'])
    assert.equal(dryRun.status, 0, dryRun.output)
    assert.match(dryRun.output, /Dry run complete/)
    assert.match(dryRun.output, /self-audit/)
    assert.equal((await client.queryModelAudits()).length, 0)

    const refused = submit(unapproved, ['--yes'])
    assert.equal(refused.status, 1, refused.output)
    assert.match(refused.output, /not approved/)

    const first = submit(approved, ['--yes', '--publish-ipfs'])
    assert.equal(first.status, 0, first.output)
    assert.match(first.output, /Submitted: 2; recovered: 0; already submitted: 0; failed: 0/)
    const uploads = (await readFile(pinataLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      model: string
      files: string[]
    })
    assert.deepEqual(uploads.map((upload) => upload.model).sort(), ['model-a', 'model-b'])

    const repeat = submit(approved, ['--yes'])
    assert.equal(repeat.status, 0, repeat.output)
    assert.match(repeat.output, /Nothing to submit/)

    const onChain = await client.queryModelAudits()
    assert.equal(onChain.length, 2)
    assert.ok(onChain.every((audit) => audit.auditor === auditor.address
      && audit.epoch === BigInt(AUDIT_EPOCH)
      && audit.evidenceUri.startsWith('ipfs://')))
    assert.deepEqual(onChain.map((audit) => audit.modelHash).sort(), [modelHash('model-a'), modelHash('model-b')].sort())
    assert.equal(await client.isVerified(1n), true)
    assert.equal(await client.isVerified(2n), false)
    assert.equal(await client.isVerified(3n), false)
    assert.equal((await client.queryServiceAudits(1n)).length, 2)
    const undetermined = await client.serviceStatus(2n, 'model-b')
    assert.equal(undetermined.verdict, VERIFIER_VERDICT.UNDETERMINED)
    assert.deepEqual(await client.auditCredits(auditor.address, AUDIT_EPOCH), { auditor: 2n, total: 2n })

    assert.equal(await client.emissionsGate(), getAddress(gateAddress))
    assert.equal(await client.validityEpochs(), 2)
    assert.equal((await client.serviceStatus(1n, 'model-a')).epoch, BigInt(AUDIT_EPOCH))
    assert.deepEqual(await client.agentStatus(1n), { verifiedCount: 2, diffCount: 0 })
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 1 })

    castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH + 1)])
    assert.equal(await client.isVerified(1n), true, 'still counts in the next epoch')
    castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH + 2)])
    assert.deepEqual(await client.agentStatus(1n), { verifiedCount: 0, diffCount: 0 })
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 0 })
    assert.equal(await client.isVerified(1n), false, 'verdicts expire without any cleanup transaction')
    assert.equal((await client.serviceStatus(1n, 'model-a')).verdict, VERIFIER_VERDICT.SAME, 'expired verdict stays readable')

    castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH + 1)])
    const stale = submit(approved, ['--yes'])
    assert.equal(stale.status, 1, stale.output)
    assert.match(stale.output, new RegExp(`current on-chain epoch is ${AUDIT_EPOCH + 1}`))
  } finally {
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

function runCli(
  dataDir: string,
  configPath: string,
  rpcUrl: string,
  args: string[],
  options: RunCliOptions = {},
): CommandResult {
  const result = spawnSync(process.execPath, [
    ...(options.importPath ? ['--import', options.importPath] : []),
    cliEntry,
    '--data-dir', dataDir,
    '--config', configPath,
    'verifier',
    ...args,
    '--rpc-url', rpcUrl,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...options.env },
  })
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

async function writeMockPinataPreload(path: string, logPath: string): Promise<void> {
  await writeFile(path, `
import { appendFileSync } from 'node:fs'

const originalFetch = globalThis.fetch
const logPath = ${JSON.stringify(logPath)}

globalThis.fetch = async (input, init) => {
  if (String(input) !== 'https://uploads.pinata.cloud/v3/files') {
    return originalFetch(input, init)
  }
  const form = init.body
  const metadata = JSON.parse(String(form.get('keyvalues')))
  appendFileSync(logPath, JSON.stringify({
    model: metadata.model,
    evidenceHash: metadata.evidenceHash,
    files: form.getAll('file').map((file) => file.name),
  }) + '\\n')
  return new Response(JSON.stringify({
    data: {
      cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3r3eifqeedsvt2eubqtskghp' + (metadata.model === 'model-a' ? 'm' : 'n'),
      size: form.getAll('file').reduce((total, file) => total + file.size, 0),
      created_at: '2026-10-07T12:00:00.000Z',
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
`)
}

function requireCommand(command: string): void {
  const result = spawnSync('which', [command], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`required command not found: ${command}`)
}

function deployContract(rpcUrl: string, contract: string, constructorArgs: string[] = []): string {
  const output = runCommand('forge', [
    'create',
    contract,
    '--rpc-url', rpcUrl,
    '--private-key', `0x${DEPLOYER_PRIVATE_KEY}`,
    '--broadcast',
    ...(constructorArgs.length > 0 ? ['--constructor-args', ...constructorArgs] : []),
  ], contractsDirectory)
  const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/)
  if (!match) throw new Error(`could not parse deployed address for ${contract}:\n${output}`)
  return match[1]!
}

function castSend(rpcUrl: string, contract: string, signature: string, args: string[]): void {
  runCommand('cast', [
    'send',
    '--rpc-url', rpcUrl,
    '--private-key', `0x${DEPLOYER_PRIVATE_KEY}`,
    contract,
    signature,
    ...args,
  ], repoRoot)
}

function runCommand(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) {
    throw new Error(`command failed: ${command} ${args.join(' ')}\n${output || '(no output)'}`)
  }
  return output
}

async function availablePort(): Promise<number> {
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

function startAnvil(port: number): ChildProcessWithoutNullStreams {
  return spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--silent'], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
}

async function waitForRpcReady(
  rpcUrl: string,
  anvil: ChildProcessWithoutNullStreams,
  timeoutMs = 20_000,
): Promise<void> {
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

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(5_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}
