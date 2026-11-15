import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { Contract, JsonRpcProvider, Wallet, encryptKeystoreJsonSync, keccak256, toUtf8Bytes } from 'ethers'
import { VerificationStorage, createResponseAuthPayload, encodeHttpRequest, encodeHttpResponse } from '@antseed/node'
import {
  availablePort,
  castSend,
  deployContract,
  repoRoot,
  startAnvil,
  stopProcess,
  waitForRpcReady,
} from './anvil.test-support.js'

const RUN_ANVIL_E2E = process.env['ANTSEED_RUN_VERIFIER_ANVIL_E2E'] === '1'
// Anvil's default account 1 (prover); a public test key.
const PROVER_PRIVATE_KEY = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const EPOCH = 5
const KEYSTORE_PASSWORD = 'test-only'
const SERVICE = 'example-model'
// The shapes `DeployTokenizerAudits.standardShapes()` registers.
const SHAPES = [
  ['/v1/chat/completions', '{"model":"', '","messages":[{"role":"user","content":"', '"}],"max_tokens":64}'],
  ['/v1/messages', '{"model":"', '","max_tokens":64,"messages":[{"role":"user","content":"', '"}]}'],
  ['/v1/responses', '{"model":"', '","max_output_tokens":64,"input":"', '"}'],
]
const MODEL_DELTA = 139
const GENERATOR_MODEL = 'probe-writer'

const cliEntry = join(repoRoot, 'apps', 'cli', 'dist', 'cli', 'index.js')

const RESULTS_ABI = [
  'function liveVerdict(uint256 agentId,bytes32 serviceHash) view returns (uint8)',
  'function auditorEpochCredits(address audit,uint256 epoch,address auditor) view returns (uint256)',
]
const AUDITS_ABI = ['function liveFlags(uint256 agentId) view returns (uint256)']

test('the tokenizer prover proves a swapped seller and flags a misreporting one against live-SAME references', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-tokenizer-prover-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const anvil = startAnvil(port)
  let proxy: Server | null = null
  try {
    await waitForRpcReady(rpcUrl, anvil)
    // ── chain: results layer, a stand-in KBF, tokenizer audits ───────
    const identityRegistry = deployContract(rpcUrl, 'test/mocks/MockERC8004Registry.sol:MockERC8004Registry')
    const gate = deployContract(rpcUrl, 'test/mocks/MockVerificationEmissionsGate.sol:MockVerificationEmissionsGate')
    const pools = deployContract(rpcUrl, 'test/mocks/MockVerificationSellerPools.sol:MockVerificationSellerPools')
    castSend(rpcUrl, gate, 'setCurrentEpoch(uint256)', [String(EPOCH - 1)])
    const results = deployContract(rpcUrl, 'verification/AntseedVerificationResults.sol:AntseedVerificationResults', [gate])
    const audits = deployContract(rpcUrl, 'verification/AntseedTokenizerAudits.sol:AntseedTokenizerAudits', [results, pools, identityRegistry])
    const kbf = deployContract(rpcUrl, 'test/mocks/MockVerificationAudit.sol:MockVerificationAudit', [results])
    castSend(rpcUrl, results, 'setAudit(address,bool)', [audits, 'true'])
    castSend(rpcUrl, results, 'setAudit(address,bool)', [kbf, 'true'])
    castSend(rpcUrl, results, 'setAuditShareBps(address,uint16)', [audits, '10000'])
    castSend(rpcUrl, gate, 'setCurrentEpoch(uint256)', [String(EPOCH)])
    castSend(rpcUrl, results, 'setRewardsStartEpoch(address,uint64)', [audits, '0'])
    for (const shape of SHAPES) castSend(rpcUrl, audits, 'setShape(bytes,bytes,bytes,bytes,bool)', [...shape.map(hex), 'true'])
    const modelHash = keccak256(toUtf8Bytes(SERVICE))
    const serviceHash = modelHash
    // Never-audited services count as the model they are sold as.
    castSend(rpcUrl, audits, 'setServiceModels(bytes32[],bytes32)', [`[${serviceHash}]`, modelHash])

    // Three KBF-verified references; a seller serving another model; a KBF-verified seller whose usage is
    // off, speaking only Anthropic Messages; an honest seller speaking only Responses.
    const CHAT = ['openai-chat-completions']
    const sellers = [
      { name: 'Reference 1', delta: MODEL_DELTA, kbfSame: true, protocols: CHAT },
      { name: 'Reference 2', delta: MODEL_DELTA, kbfSame: true, protocols: CHAT },
      { name: 'Reference 3', delta: MODEL_DELTA, kbfSame: true, protocols: CHAT },
      { name: 'Swapped', delta: 129, kbfSame: false, protocols: CHAT },
      { name: 'Misreports', delta: 152, kbfSame: true, protocols: ['anthropic-messages'] },
      { name: 'Honest', delta: MODEL_DELTA, kbfSame: false, protocols: ['openai-responses'] },
    ].map((s, index) => ({ ...s, agentId: index + 1, wallet: new Wallet(Wallet.createRandom().privateKey) }))
    for (const seller of sellers) {
      castSend(rpcUrl, identityRegistry, 'setOwner(uint256,address)', [String(seller.agentId), seller.wallet.address])
      castSend(rpcUrl, pools, 'setSeller(address,uint256)', [seller.wallet.address, String(seller.agentId)])
      castSend(rpcUrl, pools, 'setPower(uint256,uint256,uint256)', [String(seller.agentId), String(EPOCH), '100'])
      if (seller.kbfSame) castSend(rpcUrl, kbf, 'record(uint256,bytes32,bytes32,uint8)', [String(seller.agentId), serviceHash, modelHash, '1'])
    }

    // ── buyer side: a stand-in proxy whose sellers sign real receipts ─
    const dataDir = join(directory, 'prover')
    await mkdir(dataDir, { recursive: true })
    // The buyer proxy's identity collects the receipts and authorizes the prover, a separate funded keystore.
    const buyer = new Wallet(Wallet.createRandom().privateKey)
    await writeFile(join(dataDir, 'identity.key'), `${buyer.privateKey.slice(2)}\n`, { mode: 0o600 })
    const prover = new Wallet(`0x${PROVER_PRIVATE_KEY}`)
    const keystorePath = join(dataDir, 'prover.keystore.json')
    await writeFile(keystorePath, encryptKeystoreJsonSync(prover, KEYSTORE_PASSWORD, { scrypt: { N: 1024 } }), { mode: 0o600 })
    const storage = new VerificationStorage(join(dataDir, 'verification.db'))
    let probes = 0
    proxy = createHttpServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = new Uint8Array(Buffer.concat(chunks))
        const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as { model: string; messages?: Array<{ content: string }>; input?: string }
        if (parsed.model === GENERATOR_MODEL) {
          probes++
          const content = JSON.stringify({ a: `Can you check order ${probes}?`, b: `PROBE-${probes} I tried SELECT id FROM t; and got ₾ ${probes}0 😅 გამარჯობა` })
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }] }))
          return
        }
        const requestId = String(req.headers['x-antseed-request-id'])
        const pinned = String(req.headers['x-antseed-pin-peer']).toLowerCase()
        const seller = sellers.find((s) => s.wallet.address.slice(2).toLowerCase() === pinned)
        if (!seller) {
          res.writeHead(404).end()
          return
        }
        const path = String(req.url)
        const content = parsed.input ?? parsed.messages![0]!.content
        const promptTokens = 20 + (content.includes('PROBE-') ? seller.delta : 0)
        const request = { requestId, method: 'POST', path, headers: { 'content-type': 'application/json' }, body }
        const responseBody = JSON.stringify(answer(path, promptTokens))
        const response = { requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(responseBody) }
        const payload = createResponseAuthPayload({
          request, response, buyerPeerId: buyer.address, sellerPeerId: seller.wallet.address,
          advertisedService: SERVICE, provider: 'openai', responseStartedAt: Date.now(), responseCompletedAt: Date.now() + 5,
        }, seller.wallet)
        storage.insertResponseAuth({
          ...payload, receivedAt: Date.now(), verified: true, verificationError: null,
          requestPreimage: encodeHttpRequest(request), responsePreimage: encodeHttpResponse(response),
        })
        res.writeHead(200, { 'content-type': 'application/json' }).end(responseBody)
      })
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const proxyPort = (proxy.address() as { port: number }).port
    const now = Date.now()
    await writeFile(join(dataDir, 'buyer.state.json'), JSON.stringify({
      state: 'connected',
      pid: process.pid,
      port: proxyPort,
      discoveredPeers: sellers.map((seller) => ({
        peerId: seller.wallet.address.slice(2).toLowerCase(),
        displayName: seller.name,
        providers: ['openai'],
        lastSeen: now,
        providerPricing: { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { [SERVICE]: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } } },
        providerServiceApiProtocols: { openai: { services: { [SERVICE]: seller.protocols } } },
      })),
    }))
    const configPath = join(dataDir, 'config.json')
    await writeFile(configPath, JSON.stringify({
      payments: { preferredMethod: 'crypto', crypto: { chainId: 'base-local', rpcUrl, tokenizerAuditsAddress: audits } },
      verifier: { evidenceDir: join(dataDir, 'verifier', 'evidence'), keystore: keystorePath },
    }))
    const provider = new JsonRpcProvider(rpcUrl)
    const resultsContract = new Contract(results, RESULTS_ABI, provider)
    const auditsContract = new Contract(audits, AUDITS_ABI, provider)
    const verdict = async (agentId: number) => Number(await resultsContract.getFunction('liveVerdict')(agentId, serviceHash))
    // Default recheck window throughout: a dry run must not hold back the live pass after it.
    const args = ['prove-tokenizer', '--generator', GENERATOR_MODEL]

    // ── a dry run proves nothing ─────────────────────────────────────
    const dryRun = await runCli(dataDir, configPath, [...args, '--dry-run'])
    assert.equal(dryRun.status, 0, dryRun.output)
    assert.match(dryRun.output, /MISMATCH\s+Swapped example-model: 129\/129\/129, references 139\/139\/139 → proof valid \(dry run\)/)
    assert.match(dryRun.output, /USAGE MISREPORTED Misreports example-model: 152\/152\/152, references 139\/139\/139 → proof valid \(dry run\)/)
    assert.match(dryRun.output, /match\s+Honest example-model/)
    assert.equal(await verdict(4), 0)

    // ── a real pass: DIFF for the swapped seller, a usage flag for the misreporting one ─
    const submitted = await runCli(dataDir, configPath, args)
    assert.equal(submitted.status, 0, submitted.output)
    assert.match(submitted.output, /MISMATCH\s+Swapped example-model.*proved in 0x[0-9a-f]{64}/)
    assert.match(submitted.output, /USAGE MISREPORTED Misreports example-model.*proved in 0x[0-9a-f]{64}/)
    assert.equal(await verdict(4), 2, 'the swapped seller has a live DIFF')
    assert.equal(await verdict(5), 1, "the misreporting seller keeps KBF's SAME")
    assert.equal(await auditsContract.getFunction('liveFlags')(5), 1n, 'and gets a usage flag')
    assert.equal(await verdict(6), 0, 'the honest seller has no verdict')
    assert.equal(await resultsContract.getFunction('auditorEpochCredits')(audits, EPOCH, prover.address), 2n)

    // ── a later pass skips what it checked recently ──────────────────
    const later = await runCli(dataDir, configPath, args)
    assert.equal(later.status, 0, later.output)
    assert.match(later.output, /6 skipped/)
    storage.close()
  } finally {
    proxy?.close()
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

/** A non-streaming answer in the API of `path`, with its usage. */
function answer(path: string, promptTokens: number): unknown {
  if (path === '/v1/messages') {
    return {
      id: 'msg_test', type: 'message', role: 'assistant', model: SERVICE, content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: promptTokens - 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 6, output_tokens: 2 },
    }
  }
  if (path === '/v1/responses') {
    return {
      id: 'resp_test', object: 'response', status: 'completed', model: SERVICE,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
      usage: { input_tokens: promptTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, total_tokens: promptTokens + 2 },
    }
  }
  return {
    id: 'chatcmpl-test', object: 'chat.completion', model: SERVICE,
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 2, total_tokens: promptTokens + 2 },
  }
}

function hex(text: string): string {
  return `0x${Buffer.from(text, 'utf8').toString('hex')}`
}

/** Async, so the stand-in proxy in this process keeps answering while the CLI runs. */
async function runCli(dataDir: string, configPath: string, args: string[]): Promise<{ status: number; output: string }> {
  const child = spawn(process.execPath, [cliEntry, '--data-dir', dataDir, '--config', configPath, 'verifier', ...args], {
    cwd: repoRoot,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', HOME: dirname(dataDir), ANTSEED_KEYSTORE_PASSWORD: KEYSTORE_PASSWORD },
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  const [code] = await once(child, 'exit') as [number | null]
  return { status: code ?? 1, output }
}

function requireCommand(command: string): void {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} is required for this test`)
}







