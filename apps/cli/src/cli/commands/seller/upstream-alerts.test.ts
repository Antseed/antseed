import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelHealthEvent, SellerEvent, UpstreamAccountEvent } from '@antseed/node';
import { UpstreamAlerts } from '../../../seller-alerts/upstream-alerts.js';

function recorder() {
  const journaled: SellerEvent['kind'][] = [];
  const sent: Array<{ kind: SellerEvent['kind']; severity: string; title: string; providerId?: string; service?: string }> = [];
  return {
    journaled, sent,
    record: async (event: Omit<SellerEvent, 'at'>, options: { journal?: boolean; notify?: boolean } = {}) => {
      if (options.journal !== false) journaled.push(event.kind);
      if (options.notify !== false) sent.push({ kind: event.kind, severity: event.severity, title: event.title, ...(event.providerId ? { providerId: event.providerId } : {}), ...(event.service ? { service: event.service } : {}) });
    },
  };
}
const removed = (service: string): ModelHealthEvent => ({ provider: 'openai', providerId: 'deepinfra', service, status: 'removed', consecutiveFailures: 3, detail: 'HTTP 500: upstream error' });
const restored = (service: string): ModelHealthEvent => ({ ...removed(service), status: 'restored', consecutiveFailures: 0, detail: 'HTTP 200' });
const account = (status: UpstreamAccountEvent['status'], services = ['glm', 'kimi', 'qwen']): UpstreamAccountEvent => ({ provider: 'openai', providerId: 'deepinfra', status, detail: 'HTTP 402: You need positive balance to do inference', balanceUsd: null, services });

test('models withdrawn in one round are one alert per upstream, journaled one by one, and their recovery is one too', async () => {
  const log = recorder();
  const upstream = new UpstreamAlerts(log, { hostOf: () => 'api.deepinfra.com' });
  for (const service of ['glm', 'kimi', 'qwen']) upstream.modelChanged(removed(service));
  upstream.flush();
  assert.deepEqual(log.journaled, ['model_down', 'model_down', 'model_down']);
  assert.equal(log.sent.length, 1);
  assert.equal(log.sent[0]!.title, '3 models on deepinfra (api.deepinfra.com) withdrawn after failed health checks: glm, kimi, qwen');
  assert.equal(log.sent[0]!.service, undefined, 'keyed per upstream');
  for (const service of ['glm', 'kimi']) upstream.modelChanged(restored(service));
  upstream.flush();
  assert.equal(log.sent.length, 1, 'not every model is back yet');
  upstream.modelChanged(restored('qwen'));
  upstream.flush();
  assert.deepEqual(log.sent.map((event) => event.kind), ['model_down', 'model_up']);
  upstream.close();
});

test('an upstream out of credit is one critical alert naming the cause; its withdrawals add nothing; topping up closes it', async () => {
  const log = recorder();
  const upstream = new UpstreamAlerts(log, { hostOf: () => 'api.deepinfra.com' });
  upstream.account(account('out_of_credit'));
  assert.deepEqual(log.sent, [{ kind: 'upstream_credit', severity: 'critical', title: 'deepinfra (api.deepinfra.com) is out of credit: its 3 models fail until it is topped up. Top up the upstream account.', providerId: 'deepinfra' }]);
  for (const service of ['glm', 'kimi', 'qwen']) upstream.modelChanged(removed(service));
  upstream.flush();
  assert.equal(log.sent.length, 1, 'the withdrawals are journaled, not sent again');
  upstream.account(account('funded'));
  assert.equal(log.sent.at(-1)!.kind, 'upstream_credit_ok');
  upstream.account(account('low_balance'));
  upstream.account(account('funded'));
  assert.deepEqual(log.sent.slice(-2).map((event) => event.kind), ['upstream_balance_low', 'upstream_balance_ok']);
  // Topped up only part of the way: the credit alert still closes, and the low balance opens.
  upstream.account(account('out_of_credit'));
  upstream.account(account('low_balance'));
  assert.deepEqual(log.sent.slice(-3).map((event) => event.kind), ['upstream_credit', 'upstream_credit_ok', 'upstream_balance_low']);
  upstream.close();
  upstream.account(account('funded'));
  assert.equal(log.sent.at(-1)!.kind, 'upstream_balance_low', 'nothing is sent after close');
});

test('more models withdrawn in a later round update the open alert', async () => {
  const log = recorder();
  const updates: boolean[] = [];
  const upstream = new UpstreamAlerts({ record: async (event, options = {}) => { if (options.notify !== false) updates.push(options.update === true); return log.record(event, options); } });
  upstream.modelChanged(removed('glm'));
  upstream.flush();
  upstream.modelChanged(removed('kimi'));
  upstream.flush();
  upstream.flush();
  assert.deepEqual(log.sent.map((event) => event.title), ['glm on deepinfra withdrawn after failed health checks', '2 models on deepinfra withdrawn after failed health checks: glm, kimi']);
  assert.deepEqual(updates, [false, true]);
});
