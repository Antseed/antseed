import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { minedReceipt, selectedReservesReleased } from "../lib/chain.mjs";

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

describe("selectedReservesReleased", () => {
  const ACTIVE = 1;
  const SETTLED = 2;
  const reader = (channels, reserved) => ({ channelState: async (id) => channels[id], buyerBalance: async (address) => { assert.equal(address, "0xbuyer"); return { reserved }; } });
  const check = (channels, reserved, selected, others) => selectedReservesReleased({ reader: reader(channels, reserved), buyer: "0xbuyer", selected, others });

  it("is done with the other seller's channel still open and its reserve locked", async () => {
    assert.equal(await check({ a: { status: SETTLED, deposit: "1000000" }, b: { status: ACTIVE, deposit: "1000000" } }, 1_000_000n, ["a"], ["b"]), true);
  });

  it("waits while a selected channel is still open on-chain", async () => {
    assert.equal(await check({ a: { status: ACTIVE, deposit: "1000000" }, b: { status: ACTIVE, deposit: "1000000" } }, 1_000_000n, ["a"], ["b"]), false);
  });

  it("waits while more is reserved than the channels left open can hold", async () => {
    assert.equal(await check({ a: { status: SETTLED, deposit: "1000000" }, b: { status: ACTIVE, deposit: "1000000" } }, 2_000_000n, ["a"], ["b"]), false);
  });

  it("does not count another channel that has closed too, and needs zero with none left open", async () => {
    assert.equal(await check({ a: { status: SETTLED, deposit: "1000000" }, b: { status: SETTLED, deposit: "1000000" } }, 1_000_000n, ["a"], ["b"]), false);
    assert.equal(await check({ a: { status: SETTLED, deposit: "1000000" } }, 0n, ["a"], []), true);
  });
});
