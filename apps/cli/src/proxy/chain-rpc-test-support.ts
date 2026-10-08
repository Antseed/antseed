/**
 * A fake Base JSON-RPC endpoint for tests and `scripts/rpc-budget.mjs`:
 * answers the reads the buyer and gateway make (USDC balances, deposits
 * balances, credit limit, operator, Multicall3 `aggregate3`), counts every
 * HTTP request by method, and can be told to rate-limit. Anything it does
 * not know returns a zero word, which decodes as 0 / false / the zero address.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AbiCoder, Interface } from 'ethers'
import { MULTICALL3_ADDRESS } from './chain-rpc.js'

const READS = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function getBuyerBalance(address buyer) view returns (uint256 available, uint256 reserved, uint256 lastActivityAt)',
  'function getBuyerCreditLimit(address buyer) view returns (uint256)',
  'function getOperator(address buyer) view returns (address)',
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
])
const ZERO_WORD = '0x' + '0'.repeat(64)

export interface FakeChainRpc {
  url: string
  /** HTTP requests received, in total and by JSON-RPC method (an `aggregate3` counts once as `eth_call`). */
  requests: number
  byMethod: Record<string, number>
  /** Calls answered inside `aggregate3` batches. */
  batchedCalls: number
  usdc: Map<string, bigint>
  deposits: Map<string, { available: bigint; reserved: bigint }>
  creditLimit: bigint
  operators: Map<string, string>
  /** Answer the next N requests (Infinity: all) with HTTP 429. */
  rateLimit(count: number): void
  /** Answer with JSON-RPC error -32005 instead of HTTP 429. */
  rateLimitStyle: 'http' | 'jsonrpc'
  /** Forget the counters. */
  reset(): void
  close(): Promise<void>
}

export async function startFakeChainRpc(options: { evmChainId?: number; multicall?: boolean; port?: number; host?: string } = {}): Promise<FakeChainRpc> {
  const evmChainId = options.evmChainId ?? 8453
  const multicall = options.multicall !== false
  let limited = 0
  const fake: FakeChainRpc = {
    url: '',
    requests: 0,
    byMethod: {},
    batchedCalls: 0,
    usdc: new Map(),
    deposits: new Map(),
    creditLimit: 100_000_000n,
    operators: new Map(),
    rateLimit: (count) => { limited = count },
    rateLimitStyle: 'http',
    reset: () => {
      fake.requests = 0
      fake.byMethod = {}
      fake.batchedCalls = 0
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }

  const call = (to: string, data: string): { success: boolean; returnData: string } => {
    if (multicall && to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) {
      const [calls] = READS.decodeFunctionData('aggregate3', data) as unknown as [Array<{ target: string; callData: string }>]
      fake.batchedCalls += calls.length
      const results = calls.map((entry) => call(entry.target, entry.callData))
      return { success: true, returnData: READS.encodeFunctionResult('aggregate3', [results]) }
    }
    let parsed
    try {
      parsed = READS.parseTransaction({ data })
    } catch {
      parsed = null
    }
    const owner = parsed?.args[0] && typeof parsed.args[0] === 'string' ? parsed.args[0].toLowerCase() : ''
    switch (parsed?.name) {
      case 'balanceOf': return { success: true, returnData: READS.encodeFunctionResult('balanceOf', [fake.usdc.get(owner) ?? 0n]) }
      case 'getBuyerBalance': {
        const balance = fake.deposits.get(owner) ?? { available: 0n, reserved: 0n }
        return { success: true, returnData: READS.encodeFunctionResult('getBuyerBalance', [balance.available, balance.reserved, 0n]) }
      }
      case 'getBuyerCreditLimit': return { success: true, returnData: READS.encodeFunctionResult('getBuyerCreditLimit', [fake.creditLimit]) }
      case 'getOperator': return { success: true, returnData: READS.encodeFunctionResult('getOperator', [fake.operators.get(owner) ?? '0x' + '0'.repeat(40)]) }
      default: return { success: true, returnData: ZERO_WORD }
    }
  }

  const answer = (request: { id?: unknown; method?: string; params?: unknown[] }): Record<string, unknown> => {
    const id = request.id ?? null
    const method = request.method ?? ''
    const params = request.params ?? []
    switch (method) {
      case 'eth_chainId': return { jsonrpc: '2.0', id, result: '0x' + evmChainId.toString(16) }
      case 'net_version': return { jsonrpc: '2.0', id, result: String(evmChainId) }
      case 'eth_blockNumber': return { jsonrpc: '2.0', id, result: '0x100' }
      case 'eth_getBalance':
      case 'eth_getTransactionCount': return { jsonrpc: '2.0', id, result: '0x0' }
      case 'eth_gasPrice': return { jsonrpc: '2.0', id, result: '0x1' }
      case 'eth_getCode': {
        const address = String(params[0] ?? '').toLowerCase()
        const deployed = address !== MULTICALL3_ADDRESS.toLowerCase() || multicall
        return { jsonrpc: '2.0', id, result: deployed ? '0x6080604052' : '0x' }
      }
      case 'eth_getLogs': return { jsonrpc: '2.0', id, result: [] }
      case 'eth_getTransactionReceipt': return { jsonrpc: '2.0', id, result: null }
      case 'eth_call': {
        const tx = (params[0] ?? {}) as { to?: string; data?: string; input?: string }
        const result = call(tx.to ?? '', tx.data ?? tx.input ?? '0x')
        return result.success
          ? { jsonrpc: '2.0', id, result: result.returnData }
          : { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: result.returnData } }
      }
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `method ${method} not supported by the fake RPC` } }
    }
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      fake.requests++
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
      } catch {
        res.writeHead(400).end()
        return
      }
      const entries = (Array.isArray(body) ? body : [body]) as Array<{ id?: unknown; method?: string; params?: unknown[] }>
      for (const entry of entries) fake.byMethod[entry.method ?? '?'] = (fake.byMethod[entry.method ?? '?'] ?? 0) + 1
      if (limited > 0) {
        limited--
        if (fake.rateLimitStyle === 'http') {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' }).end(JSON.stringify({ error: 'rate limited' }))
        } else {
          const errors = entries.map((entry) => ({ jsonrpc: '2.0', id: entry.id ?? null, error: { code: -32005, message: 'rate limit exceeded' } }))
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(body) ? errors : errors[0]))
        }
        return
      }
      const results = entries.map(answer)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(body) ? results : results[0]))
    })
  })
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve()))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return fake
}

/** ABI-encode a uint256 (for tests that hand-craft responses). */
export function encodeUint(value: bigint): string {
  return AbiCoder.defaultAbiCoder().encode(['uint256'], [value])
}
