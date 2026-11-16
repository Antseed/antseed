import test from "node:test";
import assert from "node:assert/strict";
import { waitForLocalReceipt } from "./wash-trading-local-receipt.mjs";

test("accepts a mined receipt without waiting for another block event", async () => {
  const receipt = { status: 1, gasUsed: 123n };
  const transaction = { hash: "0x123", wait: () => { throw new Error("must not wait for block events"); } };
  const provider = { getTransactionReceipt: async (hash) => {
    assert.equal(hash, transaction.hash);
    return receipt;
  } };
  assert.equal(await waitForLocalReceipt(provider, transaction), receipt);
});

test("polls until a pending receipt is mined", async () => {
  let attempts = 0;
  const receipt = { status: 1 };
  const provider = { getTransactionReceipt: async () => ++attempts === 1 ? null : receipt };
  assert.equal(await waitForLocalReceipt(provider, { hash: "0x123" }, { pollIntervalMs: 1 }), receipt);
  assert.equal(attempts, 2);
});

test("rejects reverted transactions", async () => {
  await assert.rejects(waitForLocalReceipt({ getTransactionReceipt: async () => ({ status: 0 }) },
    { hash: "0x123" }), /local transaction reverted/);
});

test("times out rather than waiting indefinitely for an absent receipt", async () => {
  await assert.rejects(waitForLocalReceipt({ getTransactionReceipt: async () => null },
    { hash: "0x123" }, { timeoutMs: 0 }), /timed out waiting/);
});
