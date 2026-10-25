import assert from 'node:assert/strict';
import test from 'node:test';
import { addSellerHealthMetrics, type MetricSample } from '../metrics.js';
import { gasHealthState } from './start.js';

function sample(samples: MetricSample[], name: string, service?: string): MetricSample | undefined {
  return samples.find((entry) => entry.name === name && (service === undefined || entry.labels?.service === service));
}

test('seller health metrics expose withdrawn models, their upstream status and gas', () => {
  const samples: MetricSample[] = [];
  addSellerHealthMetrics(samples, { instance: 'seller' }, {
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

test('seller health metrics are empty for daemons that predate the fields', () => {
  const samples: MetricSample[] = [];
  addSellerHealthMetrics(samples, { instance: 'seller' }, { state: 'seeding' });
  addSellerHealthMetrics(samples, { instance: 'seller' }, null);
  assert.deepEqual(samples, []);
});

test('gas health state converts the monitor snapshot to ETH', () => {
  assert.equal(gasHealthState(null), null);
  const state = gasHealthState({
    getSnapshot: () => ({ address: '0xabc', depleted: true, lastBalanceWei: 10_000_000_000_000n, lastCheckedAt: 5, minBalanceWei: 50_000_000_000_000n }),
  });
  assert.deepEqual(state, { address: '0xabc', depleted: true, balanceEth: 0.00001, minBalanceEth: 0.00005, lastCheckedAt: 5 });
  assert.equal(gasHealthState({ getSnapshot: () => ({ address: '0xabc', depleted: false, lastBalanceWei: null, lastCheckedAt: null, minBalanceWei: 1n }) })?.balanceEth, null);
});
