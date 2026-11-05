import assert from 'node:assert/strict';
import test from 'node:test';
import { addRpcMetrics, addSellerHealthMetrics, type MetricSample } from '../metrics.js';
import { ethToWei } from './gas.js';
import { gasHealthState } from './start.js';

function sample(samples: MetricSample[], name: string, service?: string): MetricSample | undefined {
  return samples.find((entry) => entry.name === name && (service === undefined || entry.labels?.service === service));
}

test('seller health metrics expose withdrawn models, their upstream status and gas', () => {
  const samples: MetricSample[] = [];
  addSellerHealthMetrics(samples, { instance: 'seller' }, {
    updatedAt: Date.now(),
    modelHealth: [
      { provider: 'openai', service: 'glm-5.3', advertised: false, consecutiveFailures: 4, lastProbeAt: 1_700_000_000_500, lastStatusCode: 402, lastDetail: 'HTTP 402' },
      { provider: 'openai', service: 'kimi-k3', advertised: true, consecutiveFailures: 0, lastProbeAt: null, lastStatusCode: null, lastDetail: null },
    ],
    gas: { address: '0xabc', depleted: false, balanceEth: 0.0297, minBalanceEth: 0.00005, lastCheckedAt: 1 },
  });

  assert.equal(sample(samples, 'antseed_seller_model_advertised', 'glm-5.3')?.value, 0);
  assert.equal(sample(samples, 'antseed_seller_model_consecutive_failures', 'glm-5.3')?.value, 4);
  assert.equal(sample(samples, 'antseed_seller_model_last_status_code', 'glm-5.3')?.value, 402);
  assert.equal(sample(samples, 'antseed_seller_model_last_probe_timestamp_seconds', 'glm-5.3')?.value, 1_700_000_000);
  assert.equal(sample(samples, 'antseed_seller_model_advertised', 'kimi-k3')?.value, 1);
  assert.equal(sample(samples, 'antseed_seller_model_last_status_code', 'kimi-k3'), undefined);
  assert.equal(sample(samples, 'antseed_seller_gas_balance_eth')?.value, 0.0297);
  assert.equal(sample(samples, 'antseed_seller_gas_depleted')?.value, 0);
});

test('upstreams sharing a plugin get their own series', () => {
  const samples: MetricSample[] = [];
  addSellerHealthMetrics(samples, { instance: 'seller' }, {
    updatedAt: Date.now(),
    modelHealth: [
      { provider: 'openai', providerId: 'kimi', service: 'kimi-k3', advertised: false, consecutiveFailures: 3, lastProbeAt: null, lastStatusCode: 429, lastDetail: null },
      { provider: 'openai', providerId: 'openrouter', service: 'kimi-k3', advertised: true, consecutiveFailures: 0, lastProbeAt: null, lastStatusCode: null, lastDetail: null },
    ],
  });
  const advertised = samples.filter((entry) => entry.name === 'antseed_seller_model_advertised');
  assert.deepEqual(advertised.map((entry) => [entry.labels?.provider, entry.labels?.plugin, entry.value]), [['kimi', 'openai', 0], ['openrouter', 'openai', 1]]);
});

test('seller health metrics are empty for daemons that predate the fields', () => {
  const samples: MetricSample[] = [];
  addSellerHealthMetrics(samples, { instance: 'seller' }, { state: 'seeding', updatedAt: Date.now() });
  addSellerHealthMetrics(samples, { instance: 'seller' }, null);
  assert.deepEqual(samples, []);
});

test('gas health state converts the monitor snapshot to ETH', () => {
  assert.equal(gasHealthState(null), null);
  const state = gasHealthState({
    getSnapshot: () => ({ address: '0xabc', depleted: true, lastBalanceWei: 10_000_000_000_000n, lastCheckedAt: 5, minBalanceWei: 50_000_000_000_000n }),
  });
  assert.deepEqual(state, { address: '0xabc', depleted: true, balanceEth: 0.00001, minBalanceEth: 0.00005, lastCheckedAt: 5, refuel: null });
  const refuelState = gasHealthState(
    { getSnapshot: () => ({ address: '0xabc', depleted: false, lastBalanceWei: 1n, lastCheckedAt: 5, minBalanceWei: 1n }) },
    { getSnapshot: () => ({
      address: '0xabc', triggerBalanceWei: 500_000_000_000_000n, swapUsdcUnits: 10_000_000n, maxUsdcPerDayUnits: 30_000_000n, usdcLast24hUnits: 10_000_000n,
      inFlight: false, lastRefuel: { at: 7, usdcUnits: '10000000', txHash: '0xtx' }, lastError: null, skipped: null, nextAttemptAt: null,
    }) },
  )?.refuel;
  assert.deepEqual(refuelState, {
    triggerBalanceEth: 0.0005, swapUsdc: 10, maxUsdcPerDay: 30, usdcLast24h: 10, lastRefuel: { at: 7, usdc: 10, txHash: '0xtx' }, lastError: null, skipped: null, nextAttemptAt: null,
  });
  assert.equal(gasHealthState({ getSnapshot: () => ({ address: '0xabc', depleted: false, lastBalanceWei: null, lastCheckedAt: null, minBalanceWei: 1n }) })?.balanceEth, null);
});

test('a seller that stopped without cleaning up (crash, kill) exports no health or seller RPC series', () => {
  const samples: MetricSample[] = [];
  const stale = {
    updatedAt: 1_000,
    modelHealth: [{ provider: 'openai', service: 'glm-5.3', advertised: true, consecutiveFailures: 0, lastProbeAt: null, lastStatusCode: null, lastDetail: null }],
    gas: { address: '0xabc', depleted: false, balanceEth: 1, minBalanceEth: 0.00005, lastCheckedAt: 1 },
    rpc: { gas: { total: 5 } },
  };
  addSellerHealthMetrics(samples, { instance: 'seller' }, stale, 60_000);
  addRpcMetrics(samples, { instance: 'seller' }, stale, 60_000);
  assert.equal(samples.filter((entry) => entry.name.startsWith('antseed_seller_')).length, 0);
  assert.equal(samples.filter((entry) => entry.labels?.process === 'seller').length, 0);
  addRpcMetrics(samples, { instance: 'seller' }, stale, 2_000);
  assert.equal(samples.filter((entry) => entry.labels?.process === 'seller').length, 1);
});

test('gas minimums too small for String() still convert to wei', () => {
  assert.equal(ethToWei(0.0000001), 100_000_000_000n);
  assert.equal(ethToWei(0.00005), 50_000_000_000_000n);
  assert.equal(ethToWei(0), 0n);
  assert.equal(ethToWei(2), 2_000_000_000_000_000_000n);
});
