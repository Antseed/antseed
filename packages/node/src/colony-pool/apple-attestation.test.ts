import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestAppleCa } from './apple-attestation-testing.js';
import { APPLE_ENTERPRISE_ATTESTATION_ROOT_CA, deviceAttestationNonce, verifyDeviceAttestation } from './apple-attestation.js';

const WORKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const KEY = `04${'ab'.repeat(64)}`;
const SERIAL = 'C02TEST0MD6T';
const UDID = '00000000-0000-1000-8000-0123456789AB';

describe('Apple device attestation', () => {
  const ca = createTestAppleCa();
  const policy = { worker: WORKER, attestationKey: KEY, serialNumber: SERIAL, maxAgeS: 600, roots: [ca.rootPem] };
  const issue = (overrides: Partial<Parameters<typeof ca.issue>[0]> = {}, challenge = 'c1') =>
    ({ challenge, chain: ca.issue({ serialNumber: SERIAL, udid: UDID, nonce: deviceAttestationNonce(WORKER, KEY, challenge), ...overrides }) });

  it('embeds Apple\'s Enterprise Attestation Root CA', () => {
    const root = new X509Certificate(APPLE_ENTERPRISE_ATTESTATION_ROOT_CA);
    expect(root.subject).toContain('Apple Enterprise Attestation Root CA');
    expect(root.fingerprint256).toBe('CC:F5:9E:F8:FC:B3:01:7D:97:F8:B5:FA:6F:A9:0E:7A:3F:92:83:F7:6B:55:AC:6C:F6:ED:A8:B8:B9:49:F0:5B');
  });

  it('accepts a chain to the root that answers this worker\'s nonce for its Mac with SIP on', () => {
    const result = verifyDeviceAttestation(issue(), policy);
    expect(result.valid).toBe(true);
    expect(result.report).toMatchObject({ serialNumber: SERIAL, udid: UDID, osVersion: '26.2', sipEnabled: true });
  });

  it('rejects SIP off, another Mac, another worker or challenge, a stale leaf, and other roots', () => {
    expect(verifyDeviceAttestation(issue({ sip: false }), policy).reason).toMatch(/SIP off/);
    expect(verifyDeviceAttestation(issue({ serialNumber: 'OTHER' }), policy).reason).toMatch(/another Mac/);
    expect(verifyDeviceAttestation(issue(), { ...policy, worker: '0x0000000000000000000000000000000000000001' }).reason).toMatch(/another challenge/);
    expect(verifyDeviceAttestation({ ...issue(), challenge: 'c2' }, policy).reason).toMatch(/another challenge/);
    expect(verifyDeviceAttestation(issue({ notBefore: new Date(Date.now() - 3600_000) }), policy).reason).toMatch(/stale/);
    expect(verifyDeviceAttestation(issue(), { ...policy, roots: [createTestAppleCa().rootPem] }).reason).toMatch(/chain to Apple/);
    // With Apple's real root, a test chain never passes.
    expect(verifyDeviceAttestation(issue(), { ...policy, roots: undefined }).valid).toBe(false);
  });

  it('rejects a chain whose leaf was not issued by the next certificate', () => {
    const [leaf] = issue().chain;
    const [, otherSub] = createTestAppleCa().issue({ serialNumber: SERIAL, udid: UDID, nonce: new Uint8Array(32) });
    expect(verifyDeviceAttestation({ challenge: 'c1', chain: [leaf!, otherSub!] }, policy).valid).toBe(false);
  });
});
