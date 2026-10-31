import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from 'ethers'
import { renderKbfProbeLine } from '@antseed/fingerprints'
import { createResponseAuthPayload, encodeHttpRequest, encodeHttpResponse } from '@antseed/node'
import { KbfRoundClient, VERIFIER_VERDICT } from '@antseed/node/payments'
import type { ResponseAuthReader } from '../response-auth-reader.js'
import { referenceFixture } from '../model-audit-fixtures.test-support.js'
import { publisherTick, type PublisherDaemonContext } from './publisher-daemon.js'
import { DirectoryRoundStorage } from './storage.js'
import type { EpochBankV1, RoundTargetV1 } from './types.js'
import { verifierTick, type VerifierDaemonContext } from './verifier-daemon.js'
import { generateEncryptionKeyPair } from './sealing.js'

const RUN_ANVIL_E2E = process.env['ANTSEED_RUN_VERIFIER_ANVIL_E2E'] === '1'
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const PUBLISHER = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const VERIFIERS = [
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
]
const EPOCH = 5n
const DAY = 86_400
const MODEL = 'model-a'
const MODEL_HASH = keccak256(toUtf8Bytes(MODEL))

const compiledTestDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(compiledTestDirectory, '../../../../..')
const contractsDirectory = join(repoRoot, 'packages', 'contracts')

test('a publisher and three verifiers run one epoch end to end on Anvil', {
  skip: !RUN_ANVIL_E2E,
  timeout: 600_000,
}, async () => {
  for (const command of ['anvil', 'cast', 'forge']) {
    if (spawnSync('which', [command]).status !== 0) throw new Error(`required command not found: ${command}`)
  }
  const directory = await mkdtemp(join(tmpdir(), 'antseed-kbf-round-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--silent'], { stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    await waitForRpc(rpcUrl)
    const provider = new JsonRpcProvider(rpcUrl)
    const now = (await provider.getBlock('latest'))!.timestamp
    const genesis = now - 3_600 - Number(EPOCH) * 7 * DAY

    const registry = deploy(rpcUrl, 'core/AntseedRegistry.sol:AntseedRegistry')
    const identity = deploy(rpcUrl, 'test/mocks/MockERC8004Registry.sol:MockERC8004Registry')
    const gate = deploy(rpcUrl, 'test/mocks/MockVerificationEmissionsGate.sol:MockVerificationEmissionsGate')
    const pools = deploy(rpcUrl, 'test/mocks/MockVerificationSellerPools.sol:MockVerificationSellerPools')
    send(rpcUrl, registry, 'setIdentityRegistry(address)', [identity])
    send(rpcUrl, registry, 'setEmissions(address)', [gate])
    send(rpcUrl, gate, 'setCurrentEpoch(uint256)', [EPOCH.toString()])
    send(rpcUrl, gate, 'setSchedule(uint256,uint256)', [String(genesis), String(7 * DAY)])
    const verification = deploy(rpcUrl, 'verification/AntseedKbfVerification.sol:AntseedKbfVerification', [registry, pools])
    const publisher = new Wallet(PUBLISHER)
    const verifiers = VERIFIERS.map((key) => new Wallet(key))
    send(rpcUrl, verification, 'setPublisher(address)', [publisher.address])
    for (const verifier of verifiers) send(rpcUrl, verification, 'setVerifier(address,bool)', [verifier.address, 'true'])
    send(rpcUrl, verification, 'setModels((bytes32,string)[])', [`[(${MODEL_HASH},${MODEL})]`])
    send(rpcUrl, verification, 'setRewardsStartEpoch(uint256)', ['0'])
    send(rpcUrl, verification, 'setMaxVerifierShareBps(uint16)', ['10000'])
    send(rpcUrl, gate, 'setBudget(address,uint256,uint256)', [verification, EPOCH.toString(), '1000000000000000000000'])

    const honest = new Wallet(Wallet.createRandom().privateKey)
    const cheater = new Wallet(Wallet.createRandom().privateKey)
    send(rpcUrl, identity, 'setOwner(uint256,address)', ['1', honest.address])
    send(rpcUrl, identity, 'setOwner(uint256,address)', ['2', cheater.address])

    const bank: EpochBankV1 = { kind: 'antseed-kbf-epoch-bank', version: 1, epoch: EPOCH.toString(), models: { [MODEL]: referenceFixture(MODEL, 60) } }
    const targets: RoundTargetV1[] = [
      { agentId: '1', peerId: honest.address.slice(2).toLowerCase(), service: MODEL, serviceHash: MODEL_HASH, model: MODEL, modelHash: MODEL_HASH },
      { agentId: '2', peerId: cheater.address.slice(2).toLowerCase(), service: MODEL, serviceHash: MODEL_HASH, model: MODEL, modelHash: MODEL_HASH },
    ]
    const sellers = new Map([[targets[0]!.peerId, { wallet: honest, offset: 0 }], [targets[1]!.peerId, { wallet: cheater, offset: 500 }]])
    const storage = new DirectoryRoundStorage(join(directory, 'ipfs'))
    const clientFor = () => new KbfRoundClient({ rpcUrl, contractAddress: verification, evmChainId: 31_337, deploymentBlock: 0 })
    const logs: string[] = []
    const log = (who: string) => (message: string) => logs.push(`${who}: ${message}`)

    const publisherContext: PublisherDaemonContext = {
      client: clientFor(),
      signer: publisher,
      storage,
      stateDir: join(directory, 'publisher'),
      buildBank: async () => bank,
      discoverTargets: async () => targets,
      log: log('publisher'),
    }
    const verifierContexts: VerifierDaemonContext[] = []
    for (const [index, verifier] of verifiers.entries()) {
      const keys = generateEncryptionKeyPair()
      const client = clientFor()
      await client.setEncryptionKey(verifier, keys.publicKey)
      const fake = fakeBuyer(verifier, sellers, bank)
      verifierContexts.push({
        client,
        signer: verifier,
        address: verifier.address,
        encryptionPrivateKey: keys.privateKey,
        storage,
        // The mock pools have no seller registry; the two targets are the agents' own sellers.
        bindings: { isBound: async (peerId, agentId) => targets.some((target) => target.peerId === peerId && BigInt(target.agentId) === agentId) },
        stateDir: join(directory, `verifier-${index}`),
        // The third verifier never buys anything, so its slices go to backups.
        collector: index === 2 ? null : { buyerUrl: 'http://buyer.test', responseAuth: fake.reader, log: log(`v${index}`), fetchImpl: fake.fetch },
        log: log(`v${index}`),
      })
    }
    const tickAll = async () => {
      await publisherTick(publisherContext)
      for (const context of verifierContexts) await verifierTick(context)
    }
    const advance = async (seconds: number) => {
      const before = Number(BigInt((await provider.send('eth_getBlockByNumber', ['latest', false]) as { timestamp: string }).timestamp))
      await provider.send('evm_mine', [before + seconds])
    }

    await tickAll() // bank committed, epoch opened
    await provider.send('anvil_mine', ['0x6'])
    await tickAll() // seed fixed
    await tickAll() // plan committed, slices collected and committed
    let info = await publisherContext.client.epochInfo(EPOCH)
    assert.notEqual(BigInt(info.planHash), 0n, logs.join('\n'))
    assert.ok((await publisherContext.client.sliceCommits(EPOCH)).length >= 1, logs.join('\n'))

    await advance(3 * DAY)
    await tickAll() // backup plan, backup slices
    await tickAll()
    info = await publisherContext.client.epochInfo(EPOCH)
    assert.notEqual(BigInt(info.backupPlanHash), 0n, `the silent verifier's slices go to backups\n${logs.join('\n')}`)

    await advance(DAY)
    await tickAll() // key revealed, results attested, finalized, applied
    await tickAll()
    info = await publisherContext.client.epochInfo(EPOCH)
    assert.notEqual(BigInt(info.bankKey), 0n, logs.join('\n'))
    assert.notEqual(BigInt(info.finalizedRoot), 0n, logs.join('\n'))
    const roots = await Promise.all(verifiers.map((verifier) => publisherContext.client.attestation(EPOCH, verifier.address)))
    assert.equal(new Set(roots).size, 1, 'every verifier computed the same root')

    const statusAbi = ['function serviceStatus(uint256,bytes32) view returns ((bytes32 modelHash, uint8 verdict, uint64 updatedAt, uint64 epoch))']
    const contract = new (await import('ethers')).Contract(verification, statusAbi, provider)
    const honestStatus = await contract.getFunction('serviceStatus')(1n, MODEL_HASH)
    const cheaterStatus = await contract.getFunction('serviceStatus')(2n, MODEL_HASH)
    assert.equal(Number(honestStatus.verdict), VERIFIER_VERDICT.SAME, logs.join('\n'))
    assert.equal(Number(cheaterStatus.verdict), VERIFIER_VERDICT.DIFF, logs.join('\n'))

    send(rpcUrl, gate, 'setCurrentEpoch(uint256)', [(EPOCH + 1n).toString()])
    await advance(3 * DAY)
    for (const context of verifierContexts) await verifierTick(context)
    const mintedAbi = ['function minted(address) view returns (uint256)']
    const gateContract = new (await import('ethers')).Contract(gate, mintedAbi, provider)
    const minted = await Promise.all(verifiers.map((verifier) => gateContract.getFunction('minted')(verifier.address) as Promise<bigint>))
    assert.ok(minted.every((amount) => amount > 0n), `every attester was paid: ${minted.join(', ')}\n${logs.join('\n')}`)
    assert.ok(minted[0]! > minted[2]!, 'collectors earn more than an attest-only verifier')
  } finally {
    anvil.kill('SIGTERM')
    await Promise.race([once(anvil, 'exit'), sleep(5_000)])
    await rm(directory, { recursive: true, force: true })
  }
})

/** A buyer proxy stand-in: each seller answers with consensus (+offset) and signs the exchange. */
function fakeBuyer(
  buyer: Wallet,
  sellers: Map<string, { wallet: Wallet; offset: number }>,
  bank: EpochBankV1,
): { fetch: typeof fetch; reader: ResponseAuthReader } {
  const records = new Map<string, Awaited<ReturnType<ResponseAuthReader['waitForVerified']>>>()
  const probes = bank.models[MODEL]!.probes
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init!.headers as Record<string, string>
    const requestId = headers['x-antseed-request-id']!
    const seller = sellers.get(headers['x-antseed-pin-peer']!)!
    const bodyText = String(init!.body)
    const prompt = (JSON.parse(bodyText) as { messages: Array<{ role: string; content: string }> }).messages.find((message) => message.role === 'user')!.content
    const asked = prompt.split('\n').map((line) => probes.find((probe) => line.endsWith(renderKbfProbeLine(probe)))).filter((probe) => probe !== undefined)
    const content = asked.map((probe, index) => `(${index + 1}) ${probe!.consensus + seller.offset}`).join('\n')
    const jsonHeaders = { 'content-type': 'application/json' }
    const request = { requestId, method: 'POST', path: '/v1/chat/completions', headers: jsonHeaders, body: new TextEncoder().encode(bodyText) }
    const responseBody = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    const response = { requestId, statusCode: 200, headers: jsonHeaders, body: responseBody }
    const auth = createResponseAuthPayload({
      request, response, buyerPeerId: buyer.address, sellerPeerId: seller.wallet.address.slice(2).toLowerCase(),
      advertisedService: MODEL, provider: 'openai', responseStartedAt: 1, responseCompletedAt: 2,
    }, seller.wallet)
    records.set(requestId, {
      requestId,
      status: 'verified',
      responseAuth: { ...auth, receivedAt: 0, verified: true, verificationError: null },
      signedPreimages: {
        encoding: 'antseed-http-codec-v1',
        signatureEncoding: 'antseed-response-auth-signing-v1',
        requestBase64: Buffer.from(encodeHttpRequest(request)).toString('base64'),
        responseBase64: Buffer.from(encodeHttpResponse(response)).toString('base64'),
        responseAuthSigningBase64: '',
        requestHash: auth.requestHash,
        responseHash: auth.responseHash,
      },
      failureReason: null,
    })
    return new Response(responseBody, { status: 200, headers: jsonHeaders })
  }) as typeof fetch
  const reader: ResponseAuthReader = {
    waitForVerified: async ({ requestId }) => records.get(requestId)!,
    close: () => {},
  }
  return { fetch: fetchImpl, reader }
}

function deploy(rpcUrl: string, contract: string, args: string[] = []): string {
  const output = run('forge', ['create', contract, '--rpc-url', rpcUrl, '--private-key', DEPLOYER, '--broadcast', ...(args.length ? ['--constructor-args', ...args] : [])], contractsDirectory)
  const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/)
  if (!match) throw new Error(`could not parse deployed address for ${contract}:\n${output}`)
  return match[1]!
}

function send(rpcUrl: string, contract: string, signature: string, args: string[]): void {
  run('cast', ['send', '--rpc-url', rpcUrl, '--private-key', DEPLOYER, contract, signature, ...args], repoRoot)
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) throw new Error(`command failed: ${command} ${args.join(' ')}\n${output}`)
  return output
}

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  server.close()
  await once(server, 'close')
  return address.port
}

async function waitForRpc(rpcUrl: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
      if (response.ok) return
    } catch {
      // retry
    }
    await sleep(100)
  }
  throw new Error('Anvil did not start')
}
