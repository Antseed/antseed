import test from 'node:test';
import assert from 'node:assert/strict';
import { isCiEnvironment, resolveConsent, resolvePostHogConfig } from './consent.js';

test('DO_NOT_TRACK and ANTSEED_TELEMETRY=0 always win', () => {
  assert.deepEqual(resolveConsent({ env: { DO_NOT_TRACK: '1' }, configured: true, persisted: true }), { enabled: false, reason: 'do_not_track' });
  assert.deepEqual(resolveConsent({ env: { ANTSEED_TELEMETRY: 'off' }, configured: true, persisted: true }), { enabled: false, reason: 'env_disabled' });
});

test('dev, CI and unconfigured builds send nothing', () => {
  assert.equal(resolveConsent({ env: {}, configured: true, isDev: true }).enabled, false);
  assert.equal(resolveConsent({ env: { CI: 'true' }, configured: true }).enabled, false);
  assert.equal(resolveConsent({ env: {}, configured: false }).enabled, false);
  assert.equal(isCiEnvironment({ CI: 'false' }), false);
});

test('persisted opt-out, then default on', () => {
  assert.deepEqual(resolveConsent({ env: {}, configured: true, persisted: false }), { enabled: false, reason: 'user_disabled' });
  assert.deepEqual(resolveConsent({ env: {}, configured: true }), { enabled: true });
  assert.deepEqual(resolveConsent({ env: { DO_NOT_TRACK: '0' }, configured: true }), { enabled: true });
});

test('PostHog config: env wins, HTTPS only', () => {
  const baked = { host: 'https://eu.i.posthog.com/', projectApiKey: 'phc_baked' };
  assert.deepEqual(resolvePostHogConfig({}, baked), { host: 'https://eu.i.posthog.com', projectApiKey: 'phc_baked' });
  assert.equal(resolvePostHogConfig({ POSTHOG_HOST: 'http://insecure' }, baked), null);
  assert.equal(resolvePostHogConfig({}, { host: null, projectApiKey: null }), null);
});
