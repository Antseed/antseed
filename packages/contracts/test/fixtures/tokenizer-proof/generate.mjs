// Regenerates TokenizerProofFixture.sol: three rounds signed by the real seller ResponseAuth code and
// encoded by the prover's client, so the Solidity tests check both sides of the format against each other.
// The suspect answers in Anthropic Messages and the references in Chat Completions and Responses, in the
// shapes `DeployTokenizerAudits.standardShapes()` registers, so the test also fails if those drift.
// Run from the repo root after `pnpm run build`:
//   node packages/contracts/test/fixtures/tokenizer-proof/generate.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AbiCoder, Wallet, keccak256 } from 'ethers'
import { createResponseAuthPayload } from '../../../../buyer-core/dist/response-auth.js'
import { encodeHttpRequest, encodeHttpResponse } from '../../../../protocol/dist/request-codec.js'
import { roundTuple, shapeRequestBody } from '../../../../node/dist/payments/evm/tokenizer-audits-client.js'

const here = dirname(fileURLToPath(import.meta.url))
// Throwaway test keys; never funded.
const suspect = new Wallet('0x' + '11'.repeat(32))
const references = ['33', '44', '55'].map((b) => new Wallet('0x' + b.repeat(32)))
const buyer = new Wallet('0x' + '22'.repeat(32))
const service = 'example-model'
const encoder = new TextEncoder()
const withId = (shape) => ({
  ...shape,
  shapeId: keccak256(AbiCoder.defaultAbiCoder().encode(['bytes', 'bytes', 'bytes', 'bytes'], [shape.path, shape.head, shape.mid, shape.tail].map((s) => encoder.encode(s)))),
})
const CHAT = withId({ path: '/v1/chat/completions', head: '{"model":"', mid: '","messages":[{"role":"user","content":"', tail: '"}],"max_tokens":64}' })
const MESSAGES = withId({ path: '/v1/messages', head: '{"model":"', mid: '","max_tokens":64,"messages":[{"role":"user","content":"', tail: '"}]}' })
const RESPONSES = withId({ path: '/v1/responses', head: '{"model":"', mid: '","max_output_tokens":64,"input":"', tail: '"}' })
// What each API answers, with its usage.
const ANSWERS = {
  [CHAT.path]: (tokens) => ({ id: 'chatcmpl-example', object: 'chat.completion', model: service, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: tokens, completion_tokens: 2, total_tokens: tokens + 2 } }),
  [MESSAGES.path]: (tokens) => ({ id: 'msg_example', type: 'message', role: 'assistant', model: service, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: tokens - 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 8, output_tokens: 2 } }),
  [RESPONSES.path]: (tokens) => ({ id: 'resp_example', object: 'response', status: 'completed', model: service, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: tokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, total_tokens: tokens + 2 } }),
}
let id = 0

function signed(wallet, shape, content, promptTokens) {
  const requestId = `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`
  const request = { requestId, method: 'POST', path: shape.path, headers: { 'content-type': 'application/json' }, body: encoder.encode(shapeRequestBody(shape, service, content)) }
  const response = {
    requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
    body: encoder.encode(JSON.stringify(ANSWERS[shape.path](promptTokens))),
  }
  const payload = createResponseAuthPayload({
    request, response, buyerPeerId: buyer.address, sellerPeerId: wallet.address, advertisedService: service,
    provider: 'openai', responseStartedAt: 1_800_000_000_000 + id * 1000, responseCompletedAt: 1_800_000_000_500 + id * 1000,
  }, wallet)
  return { payload, request: encodeHttpRequest(request), response: encodeHttpResponse(response) }
}
const pair = (wallet, shape, a, b, delta) => ({ shapeId: shape.shapeId, base: signed(wallet, shape, a, 20), probed: signed(wallet, shape, a + b, 20 + delta) })

const rounds = [
  ['Can you check this SQL for me?', ' SELECT id FROM orders WHERE total > 450; — my coworker wrote “μάλλον είναι η βάση” 😅 on 03/11/2024.'],
  ['What should I pack for Tbilisi?', ' გამარჯობა! I land on the 14th with ₾ 300 and a `packing_list.yaml` I never finish 🧳.'],
  ['Is this regex right?', ' `^[a-z0-9_-]{3,16}$` — Kenji said しょうがない and moved on, ticket #88213 still open 🙃.'],
].map(([a, b]) => ({
  a, b,
  suspect: pair(suspect, MESSAGES, a, b, 129),
  references: [CHAT, RESPONSES, CHAT].map((shape, k) => pair(references[k], shape, a, b, 139)),
}))

const RECEIPT = 'tuple(uint32,string,string,address,address,string,string,uint16,uint64,uint64,bytes,bytes,bytes)'
const PAIR = `tuple(bytes32,${RECEIPT},${RECEIPT})`
const encodedRounds = AbiCoder.defaultAbiCoder().encode([`tuple(bytes,bytes,${PAIR},${PAIR}[])[]`], [rounds.map(roundTuple)])
writeFileSync(join(here, 'TokenizerProofFixture.sol'), `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Generated by generate.mjs; do not edit. Three rounds for \`${service}\` signed by the TypeScript seller
///      code (\`createResponseAuthPayload\`) with throwaway keys and encoded by the prover's client
///      (\`roundTuple\`): the suspect (Anthropic Messages) reports a delta of 129 in each, the three references
///      (Chat Completions, Responses, Chat Completions) 139.
library TokenizerProofFixture {
    string internal constant SERVICE = "${service}";
    address internal constant SUSPECT = ${suspect.address};
    address internal constant REFERENCE_0 = ${references[0].address};
    address internal constant REFERENCE_1 = ${references[1].address};
    address internal constant REFERENCE_2 = ${references[2].address};
    bytes internal constant ENCODED_ROUNDS = hex"${encodedRounds.slice(2)}";
}
`)
console.log('wrote TokenizerProofFixture.sol')
