// #1050, ported from the payment stress harness (e2e/stress/harness.mjs stale1050Phase) onto the testbench network.
// The buyer pays, goes away, and the seller closes the channel on disconnect. The buyer's store still lists the
// channel as active while it is offline. After a restart, without talking to that seller again, the buyer must
// retire the row: its store, /_antseed/buyer-usage, /_antseed/channels and `antseed buyer status` all count 0.
// Then it pays again on a fresh channel, and the payment oracle judges both phases.
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { channelRows, cliActiveChannels, clientSummary, findNumber, GATES, gateProblems, runAll, STRESS_MODEL, stressTopology, warmUp } from '../../lib/stress.mjs';

export const meta = {
  description: '#1050: after the seller closes a channel on disconnect, the restarted buyer retires it everywhere (store, buyer-usage, channels view, buyer status) and pays again on a fresh channel; the payment oracle balances both phases.',
  targets: ['local', 'fork'],
  requires: ['buyerControl', 'mockControl'],
};

export const topology = stressTopology();

const LOAD = { model: STRESS_MODEL, concurrency: 4, requests: 24 };
const RECONCILE_WAIT_MS = 90_000;
// The Base-like RPC answers a block behind for this long after a transaction (e2e/stress/rpc-proxy.mjs lagWindowMs).
const RPC_LAG_WINDOW_MS = 4000;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function proxyJson(tb, path) {
  try {
    const response = await fetch(`${tb.proxyUrl}${path}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return { json: await response.json() };
  } catch (error) {
    return { error: error.message };
  }
}

/** Both loads count as one gated run of 48 requests, as in the stress harness. */
export function combinedGate(results, gate = GATES['issue-1050']) {
  const client = clientSummary(results);
  return { client, gate, gateProblems: gateProblems(client, gate) };
}

export async function run(tb) {
  const buyerDir = tb.manifest.buyerDir;
  const activeIds = () => channelRows(buyerDir, 'buyer').filter((row) => row.status === 'active').map((row) => row.session_id);
  const before = await tb.paymentSnapshot();
  await warmUp(tb);
  const first = await tb.load(LOAD);
  await sleep(5000); // let post-response auths land

  const paid = activeIds();
  tb.check('the buyer has an active channel after paying', paid.length > 0, paid);
  await tb.stopBuyer();
  await tb.waitFor(async () => {
    for (const id of paid) if ((await tb.channelState(id)).status === 1) return false;
    return true;
  }, 'the seller to close the channel on-chain after the disconnect', { timeoutMs: 180_000, intervalMs: 2000 });
  const staleWhileStopped = activeIds().filter((id) => paid.includes(id));
  tb.check('the stopped buyer still lists the closed channel as active (the state #1050 starts from)', staleWhileStopped.length > 0, { staleWhileStopped });

  // `buyer status` reconciles the store it reads, so it gets a copy: the restarted buyer must retire the row itself.
  const offline = join(tb.manifest.dir, 'buyer-offline-copy');
  await rm(offline, { recursive: true, force: true });
  await cp(buyerDir, offline, { recursive: true });
  // `buyer status` leaves each seller's current channel to a running buyer when buyer.state.json's pid is alive.
  // The testbench buyer runs inside the supervisor, whose pid outlives stopBuyer(); the stress harness's buyer is
  // its own CLI process and is gone by now. Clear the pid in the copy so it reads like that stopped buyer's dir.
  const stateFile = join(offline, 'buyer.state.json');
  await writeFile(stateFile, JSON.stringify({ ...JSON.parse(await readFile(stateFile, 'utf8')), pid: null }));
  const cli = { home: tb.manifest.home, configPath: tb.manifest.buyerConfig, run: tb.cli };
  const offlineFirst = await cliActiveChannels({ ...cli, dataDir: offline });
  await sleep(RPC_LAG_WINDOW_MS * 2);
  const offlineSecond = await cliActiveChannels({ ...cli, dataDir: offline });
  tb.check('the offline status read left the buyer store alone', activeIds().filter((id) => paid.includes(id)).length === staleWhileStopped.length);
  tb.check('offline `buyer status` answers', !offlineFirst.error && !offlineSecond.error, { offlineFirst, offlineSecond });
  // The first read can land inside the RPC's post-transaction lag; the one after the lag window must count 0.
  tb.check('offline `buyer status` counts 0 active channels after the RPC lag window', offlineSecond.count === 0, offlineSecond);
  await rm(offline, { recursive: true, force: true });

  await tb.startBuyer();
  const restartedAt = Date.now();
  let stale = -1;
  await tb.waitFor(() => { stale = activeIds().filter((id) => paid.includes(id)).length; return stale === 0; }, 'the restarted buyer to retire the closed channel', { timeoutMs: RECONCILE_WAIT_MS, intervalMs: 1000 }).catch(() => {});
  tb.metric('retiredAfterRestartMs', stale === 0 ? Date.now() - restartedAt : null);
  tb.check('the restarted buyer retired the closed channel in its store', stale === 0, { stale });
  const usage = await proxyJson(tb, '/_antseed/buyer-usage');
  const usageCount = findNumber(usage.json, 'activeChannels');
  const channels = await proxyJson(tb, '/_antseed/channels');
  const running = await cliActiveChannels({ ...cli, dataDir: buyerDir });
  const surfaces = {
    'buyer-usage': typeof usageCount === 'number' ? { count: usageCount } : { error: usage.error ?? 'no activeChannels in the response' },
    'channels view': Array.isArray(channels.json?.channels) ? { count: channels.json.channels.length } : { error: channels.error ?? 'no channels in the response' },
    'buyer status': running,
  };
  // Every surface must answer, and answer 0: a missing count is not a pass.
  for (const [surface, read] of Object.entries(surfaces)) tb.check(`${surface} counts 0 active channels after the restart`, !read.error && read.count === 0, read);

  const second = await tb.load(LOAD);
  const results = [...first.results, ...second.results];
  await runAll([
    () => tb.assertDeliveredWorkPaid({ before, results, injected: {} }),
    () => tb.assertNoCrashes(),
    () => tb.checkGate(combinedGate(results)),
  ]);
}
