import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { launchProfileDesktop } from './desktop.mjs';

const require = createRequire(import.meta.url);

/** Read-only Base mainnet reads for the test wallet (deposit balance and channel settlements). */
export function mainnetReader(rpcUrl, chain) {
  const { Contract, JsonRpcProvider } = require('ethers');
  const provider = new JsonRpcProvider(rpcUrl, chain.evmChainId ?? 8453, { staticNetwork: true });
  const deposits = new Contract(chain.depositsContractAddress, ['function getBuyerBalance(address) view returns(uint256 available,uint256 reserved,uint256 lastActivityAt)'], provider);
  return {
    async buyerBalance(address) {
      const value = await deposits.getBuyerBalance(address);
      return { available: value.available, reserved: value.reserved };
    },
    close() { provider.destroy(); },
  };
}

/**
 * Scenario API for the full desktop on the real network. Same shape as the sandbox `sb` where it makes sense
 * (check, knownIssue, metric, event, waitFor, desktop), plus real-network helpers. Every chat is guarded by
 * the per-run spend cap: signed spend above `capMicros` fails the run.
 */
export function createMainnetApi({ repo, env, instance, profile, reader, reportDir, eventsPath, capMicros, strict = false, trace = false }) {
  const checks = [];
  const knownIssues = [];
  const metrics = {};
  const desktops = [];
  let proxyUrl = null;
  const event = async (type, data = {}) => {
    await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`);
  };
  const proxy = async (path, init = {}) => {
    assert(proxyUrl, 'The desktop buyer is not running yet; call sb.desktop() first');
    return fetch(`${proxyUrl}${path}`, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  };

  const sb = {
    target: 'mainnet',
    wallet: profile.address,
    capMicros,
    event,
    get proxyUrl() { return proxyUrl; },
    check(name, ok, detail) {
      checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) });
      assert(ok, `${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    },
    knownIssue(name, ok, detail, issue) {
      const entry = { name, ok: Boolean(ok), issue, ...(detail !== undefined ? { detail } : {}) };
      knownIssues.push(entry);
      if (!entry.ok && strict) assert.fail(`${name} (known issue: ${issue}): ${JSON.stringify(detail)}`);
    },
    metric(name, value) { metrics[name] = value; },
    async waitFor(predicate, label, { timeoutMs = 60_000, intervalMs = 1000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await predicate().catch(() => null);
        if (value) return value;
        await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    },
    /** Launches the full desktop (its own buyer on the real network) under Playwright; closed after the run. */
    async desktop() {
      const ui = await launchProfileDesktop({ repo, env, instance, reportDir, event, trace });
      desktops.push(ui);
      proxyUrl = `http://127.0.0.1:${profile.buyerProxyPort}`;
      return ui;
    },
    /** Waits until the desktop's buyer answers and has discovered at least `min` sellers. */
    async waitForPeers({ min = 1, timeoutMs = 180_000 } = {}) {
      return sb.waitFor(async () => {
        const body = await (await proxy('/_antseed/peers')).json();
        return (body.peers ?? []).length >= min ? body.peers : null;
      }, `the desktop buyer discovering ${min}+ sellers`, { timeoutMs, intervalMs: 2000 });
    },
    async models() {
      const body = await (await proxy('/v1/models')).json();
      return body.data ?? [];
    },
    async channels({ all = false } = {}) {
      const body = await (await proxy(`/_antseed/channels${all ? '?all=1' : ''}`)).json();
      return body.channels ?? [];
    },
    /** Cumulative signed micro-USDC per channel; pass it to spentSince() later to get this run's spend. */
    async signedSnapshot() {
      return new Map((await sb.channels({ all: true })).map((channel) => [channel.channelId, BigInt(channel.cumulativeSigned ?? '0')]));
    },
    /** Micro-USDC signed since the snapshot, across new and reused channels. */
    async spentSince(snapshot) {
      const now = await sb.signedSnapshot();
      let spent = 0n;
      for (const [channelId, signed] of now) spent += signed - (snapshot.get(channelId) ?? 0n);
      return spent;
    },
    /** Fails the run when spend since the snapshot exceeds the per-run cap; returns the spend. */
    async assertWithinCap(snapshot) {
      const spent = await sb.spentSince(snapshot);
      sb.metric('signedThisRunMicroUsdc', String(spent));
      sb.check(`signed spend within the per-run cap (${capMicros} micro-USDC)`, spent <= capMicros, String(spent));
      return spent;
    },
    buyerBalance: () => reader.buyerBalance(profile.address),
    summary() { return { checks, knownIssues, metrics }; },
    async dispose() {
      for (const ui of desktops.splice(0)) await ui.close().catch(() => {});
      reader.close();
    },
  };
  return sb;
}
