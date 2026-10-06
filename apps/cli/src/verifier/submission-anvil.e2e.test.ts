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
import { Wallet } from 'ethers'
import { VerificationStorage } from '@antseed/node'
import { VerifierClient } from '@antseed/node/payments'
import {
  FIXTURE_CONFIG,
  referenceFixture,
  writeSignedAuditRun,
  type FixtureAudit,
} from './audit-report-fixtures.test-support.js'
import { submissionLedgerPath, type ReportSubmissionLedgerV1 } from './submission-ledger.js'

const randomWallet = (): Wallet => new Wallet(Wallet.createRandom().privateKey)
const RUN_ANVIL_E2E = process.env['ANTSEED_RUN_VERIFIER_ANVIL_E2E'] === '1'
const DEPLOYER_PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const AUDITOR_PRIVATE_KEYS = [
  '8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
] as const
const VERIFIER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const SELLER_OWNERS = [
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
] as const
const RUN_ID = 'anvil-report-run'
const EPOCH = '2026-10-07'

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

test('two auditors sign reports, one verifier checks and submits both, and the score finalizes', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-report-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const anvil = startAnvil(port)
  try {
    await waitForRpcReady(rpcUrl, anvil)
    const registryAddress = deployContract(rpcUrl, 'core/AntseedRegistry.sol:AntseedRegistry')
    const identityRegistryAddress = deployContract(
      rpcUrl,
      'test/mocks/MockERC8004Registry.sol:MockERC8004Registry',
    )
    const verificationAddress = deployContract(
      rpcUrl,
      'verification/AntseedVerification.sol:AntseedVerification',
      [registryAddress],
    )
    castSend(rpcUrl, registryAddress, 'setIdentityRegistry(address)', [identityRegistryAddress])
    castSend(rpcUrl, verificationAddress, 'setVerifier(address,bool)', [VERIFIER_ADDRESS, 'true'])
    const auditors = AUDITOR_PRIVATE_KEYS.map((key) => new Wallet(`0x${key}`))
    // Agent 3 belongs to the first auditor, who must not audit it.
    const owners = [...SELLER_OWNERS, auditors[0]!.address]
    for (const [index, owner] of owners.entries()) {
      castSend(rpcUrl, identityRegistryAddress, 'setOwner(uint256,address)', [String(index + 1), owner])
    }

    const sellers = [randomWallet(), randomWallet(), randomWallet()]
    // Both auditors audit against the same references so their results agree.
    const references = { 'model-a': referenceFixture('model-a'), 'model-b': referenceFixture('model-b') }
    const audits: FixtureAudit[] = [
      { agentId: '1', seller: sellers[0]!, model: 'model-a', service: 'model-a', verdict: 'SAME', reference: references['model-a'] },
      { agentId: '1', seller: sellers[0]!, model: 'model-b', service: 'model-b', verdict: 'SAME', reference: references['model-b'] },
      { agentId: '2', seller: sellers[1]!, model: 'model-a', service: 'model-a', verdict: 'DIFF', reference: references['model-a'] },
      { agentId: '3', seller: sellers[2]!, model: 'model-b', service: 'model-b', verdict: 'SAME', reference: references['model-b'] },
    ]

    const crypto = {
      chainId: 'base-local',
      rpcUrl,
      verificationContractAddress: verificationAddress,
      verificationDeployBlock: 0,
      identityRegistryAddress,
    }
    const auditorDirs: Array<{ dataDir: string; configPath: string; evidenceDir: string }> = []
    for (const [index, auditor] of auditors.entries()) {
      const dataDir = join(directory, `auditor-${index + 1}`)
      const evidenceDir = join(dataDir, 'verifier', 'evidence')
      const banksDir = join(dataDir, 'verifier', 'banks')
      const configPath = join(dataDir, 'config.json')
      await mkdir(dataDir, { recursive: true })
      await writeFile(join(dataDir, 'identity.key'), `${AUDITOR_PRIVATE_KEYS[index]}\n`, { mode: 0o600 })
      await writeFile(configPath, JSON.stringify({
        payments: { preferredMethod: 'crypto', crypto },
        verifier: { evidenceDir, banksDir, ...FIXTURE_CONFIG },
      }))
      const { requestCosts } = await writeSignedAuditRun({ evidenceDir, banksDir, runId: RUN_ID, epoch: EPOCH, auditor, audits })
      const storage = new VerificationStorage(join(dataDir, 'verification.db'))
      try {
        for (const cost of requestCosts.values()) storage.insertRequestCost(cost)
      } finally {
        storage.close()
      }
      auditorDirs.push({ dataDir, configPath, evidenceDir })
    }

    const verifierDataDir = join(directory, 'verifier')
    const verifierConfigPath = join(verifierDataDir, 'config.json')
    const verifierEvidenceDir = join(verifierDataDir, 'verifier', 'evidence')
    await mkdir(verifierDataDir, { recursive: true })
    await writeFile(join(verifierDataDir, 'identity.key'), `${DEPLOYER_PRIVATE_KEY}\n`, { mode: 0o600 })
    await writeFile(verifierConfigPath, JSON.stringify({
      payments: { preferredMethod: 'crypto', crypto },
      verifier: {
        evidenceDir: verifierEvidenceDir,
        banksDir: join(verifierDataDir, 'verifier', 'banks'),
        ...FIXTURE_CONFIG,
      },
    }))

    const pinataLogPath = join(directory, 'pinata-uploads.jsonl')
    const pinataPreloadPath = join(directory, 'mock-pinata.mjs')
    await writeMockPinataPreload(pinataPreloadPath, pinataLogPath)

    const firstReport = runCli(auditorDirs[0]!.dataDir, auditorDirs[0]!.configPath, rpcUrl, [
      'report', '--run-id', RUN_ID, '--publish-ipfs',
    ], { importPath: pinataPreloadPath, env: { PINATA_JWT: 'test-pinata-jwt' } })
    assert.equal(firstReport.status, 0, firstReport.output)
    assert.match(firstReport.output, /Reports signed: 2; excluded audits: 1/)
    assert.match(firstReport.output, /self-audit/)
    const uploads = (await readFile(pinataLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      agentId: string
      files: string[]
    })
    assert.deepEqual(uploads.map((upload) => upload.agentId).sort(), ['1', '2'])
    assert.ok(uploads.every((upload) => upload.files.includes('publication.json')))
    const secondReport = runCli(auditorDirs[1]!.dataDir, auditorDirs[1]!.configPath, rpcUrl, [
      'report', '--run-id', RUN_ID,
    ])
    assert.equal(secondReport.status, 0, secondReport.output)
    assert.match(secondReport.output, /Reports signed: 3; excluded audits: 0/)

    const reportsDir = (index: number) => join(auditorDirs[index]!.evidenceDir, 'reports', RUN_ID)
    const firstReportFile = JSON.parse(await readFile(join(reportsDir(0), '1.report.json'), 'utf8')) as {
      evidenceUri: string
    }
    assert.match(firstReportFile.evidenceUri, /^ipfs:\/\//)

    const client = new VerifierClient({ rpcUrl, contractAddress: verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })
    const submit = (index: number, extra: string[]) => runCli(verifierDataDir, verifierConfigPath, rpcUrl, [
      'submit', '--report', reportsDir(index), ...extra,
    ])

    const dryRun = submit(0, ['--dry-run'])
    assert.equal(dryRun.status, 0, dryRun.output)
    assert.match(dryRun.output, /Dry run complete/)
    assert.equal((await client.queryReports()).length, 0)

    const tamperedPath = join(reportsDir(1), '2.report.json')
    const original = await readFile(tamperedPath, 'utf8')
    const tampered = JSON.parse(original) as { results: Array<{ flags: number }> }
    tampered.results[0]!.flags |= 1
    await writeFile(tamperedPath, JSON.stringify(tampered))
    const refused = submit(1, ['--dry-run'])
    assert.equal(refused.status, 1, refused.output)
    assert.match(refused.output, /Refusing .*2\.report\.json/)
    assert.match(refused.output, /results: resultsHash does not match the results/)
    await writeFile(tamperedPath, original)

    const first = submit(0, ['--yes'])
    assert.equal(first.status, 0, first.output)
    assert.match(first.output, /Submitted: 2; skipped: 0; refused: 0; failed: 0/)
    assert.equal((await client.agentScore(1n)).finalizedAt, 0n)

    const repeat = submit(0, ['--yes'])
    assert.equal(repeat.status, 0, repeat.output)
    assert.match(repeat.output, /Submitted: 0; skipped: 2; refused: 0; failed: 0/)

    const second = submit(1, ['--yes'])
    assert.equal(second.status, 0, second.output)
    assert.match(second.output, /Submitted: 3; skipped: 0; refused: 0; failed: 0/)

    const reports = await client.queryReports()
    assert.equal(reports.length, 5)
    assert.ok(reports.every((report) => report.verifier === VERIFIER_ADDRESS))
    assert.deepEqual(
      new Set(reports.filter((report) => report.agentId === 1n).map((report) => report.auditor)),
      new Set(auditors.map((auditor) => auditor.address)),
    )
    const agentOne = await client.agentScore(1n)
    assert.ok(agentOne.finalizedAt > 0n)
    assert.ok(agentOne.scoreBps > 0)
    const agentTwo = await client.agentScore(2n)
    assert.ok(agentTwo.finalizedAt > 0n)
    assert.equal(agentTwo.scoreBps, 0)
    assert.equal((await client.agentScore(3n)).finalizedAt, 0n)
    assert.equal((await client.queryServiceAudits(1n)).length, 4)

    const ledger = JSON.parse(await readFile(
      submissionLedgerPath(verifierEvidenceDir, 31_337n, verificationAddress),
      'utf8',
    )) as ReportSubmissionLedgerV1
    const entries = Object.values(ledger.reports)
    assert.equal(entries.length, 5)
    assert.ok(entries.every((entry) => entry.status === 'submitted' && entry.transactionHash))
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
    agentId: metadata.agentId,
    evidenceHash: metadata.evidenceHash,
    files: form.getAll('file').map((file) => file.name),
  }) + '\\n')
  return new Response(JSON.stringify({
    data: {
      cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3r3eifqeedsvt2eubqtskghp' + 'mnp'[Number(metadata.agentId) % 3],
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
