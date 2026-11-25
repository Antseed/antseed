import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Interface, Wallet, makeError, type TransactionRequest } from 'ethers'
import { erc1271SignatureCheck } from './x402.js'

const wallet = new Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'])
const account = Wallet.createRandom().address
const digest = `0x${'11'.repeat(32)}`
const signature = `0x00${'22'.repeat(65)}`

/** A contract runner whose `eth_call` answers with `answer`. */
function runner(answer: (tx: TransactionRequest) => Promise<string>) {
  const calls: TransactionRequest[] = []
  return {
    calls,
    runner: { provider: null, call: async (tx: TransactionRequest) => { calls.push(tx); return answer(tx) } },
  }
}

test('erc1271SignatureCheck accepts only the ERC-1271 magic value from the payer contract', async () => {
  const approving = runner(async () => wallet.encodeFunctionResult('isValidSignature', ['0x1626ba7e']))
  assert.equal(await erc1271SignatureCheck(approving.runner)(account, digest, signature), true)
  assert.equal(approving.calls[0]!.to, account)
  assert.equal(approving.calls[0]!.data, wallet.encodeFunctionData('isValidSignature', [digest, signature]))

  const refusing = runner(async () => wallet.encodeFunctionResult('isValidSignature', ['0xffffffff']))
  assert.equal(await erc1271SignatureCheck(refusing.runner)(account, digest, signature), false)
})

test('erc1271SignatureCheck treats a revert or an address without code as a refusal, and throws when the chain cannot be read', async () => {
  const reverting = runner(async (tx) => {
    throw makeError('execution reverted', 'CALL_EXCEPTION', {
      action: 'call', data: '0x', reason: null, transaction: { to: tx.to as string, data: tx.data as string }, invocation: null, revert: null,
    })
  })
  assert.equal(await erc1271SignatureCheck(reverting.runner)(account, digest, signature), false)

  // An address without code answers an empty result.
  const noCode = runner(async () => '0x')
  assert.equal(await erc1271SignatureCheck(noCode.runner)(account, digest, signature), false)

  const unreachable = runner(async () => { throw new Error('every RPC endpoint is backing off') })
  await assert.rejects(erc1271SignatureCheck(unreachable.runner)(account, digest, signature), /backing off/)
})
