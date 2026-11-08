import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { minedReceipt } from "../lib/chain.mjs";

describe("minedReceipt", () => {
  it("finds a transaction mined after the first check, without waiting for a later block", async () => {
    // ethers wait() never settles here: automine produces no block after the one holding this transaction.
    const transaction = { hash: "0xabc", wait: () => new Promise(() => {}) };
    let polls = 0;
    const provider = { getTransactionReceipt: async (hash) => { assert.equal(hash, "0xabc"); polls += 1; return polls < 3 ? null : { status: 1 }; } };
    assert.deepEqual(await minedReceipt(transaction, provider, { intervalMs: 1 }), { status: 1 });
    assert.equal(polls, 3);
  });

  it("fails with the hash when the transaction never mines", async () => {
    const provider = { getTransactionReceipt: async () => null };
    await assert.rejects(minedReceipt({ hash: "0xdead" }, provider, { timeoutMs: 20, intervalMs: 1 }), /0xdead was not mined within 0\.02s/);
  });
});
