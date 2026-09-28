import {describe, expect, it} from 'vitest';
import {
  INSTALL_TOKEN_MAX_AGE_MS,
  installTokenFromFilename,
  mintInstallToken,
  stampAssetName,
  verifyInstallToken,
} from './attribution';

const SECRET = 'test-secret';
const NOW = 1_757_500_000_000;
const ids = {clientId: '1234567890.1234567890', sessionId: '1757499000'};

describe('install attribution tokens', () => {
  it('round-trips the GA ids through a signed token', async () => {
    const token = await mintInstallToken(ids, SECRET, NOW);
    expect(token).toMatch(/^1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    const verified = await verifyInstallToken(token!, SECRET, NOW + 5_000);
    expect(verified).toEqual({clientId: ids.clientId, sessionId: ids.sessionId, issuedAtMs: 1_757_500_000_000, ref: null});
  });

  it('carries an affiliate ref and rejects malformed ones', async () => {
    const token = await mintInstallToken(ids, SECRET, NOW, 'partner_42');
    expect((await verifyInstallToken(token!, SECRET, NOW))?.ref).toBe('partner_42');
    // a pre-ref (three-field) payload still verifies
    const legacy = (await mintInstallToken(ids, SECRET, NOW))!;
    expect((await verifyInstallToken(legacy, SECRET, NOW))?.ref).toBeNull();
  });

  it('mints nothing without a client id or secret', async () => {
    expect(await mintInstallToken({clientId: null, sessionId: null}, SECRET, NOW)).toBeNull();
    expect(await mintInstallToken(ids, '', NOW)).toBeNull();
  });

  it('keeps a missing session id as null', async () => {
    const token = await mintInstallToken({clientId: ids.clientId, sessionId: null}, SECRET, NOW);
    expect((await verifyInstallToken(token!, SECRET, NOW))?.sessionId).toBeNull();
  });

  it('rejects forged, tampered, and stale tokens', async () => {
    const token = (await mintInstallToken(ids, SECRET, NOW))!;
    expect(await verifyInstallToken(token, 'other-secret', NOW)).toBeNull();
    const [version, payload, sig] = token.split('.');
    const flipped = sig!.endsWith('A') ? `${sig!.slice(0, -1)}B` : `${sig!.slice(0, -1)}A`;
    expect(await verifyInstallToken(`${version}.${payload}.${flipped}`, SECRET, NOW)).toBeNull();
    expect(await verifyInstallToken(`${version}.${payload}x.${sig}`, SECRET, NOW)).toBeNull();
    expect(await verifyInstallToken(token, SECRET, NOW + INSTALL_TOKEN_MAX_AGE_MS + 1)).toBeNull();
    expect(await verifyInstallToken('garbage', SECRET, NOW)).toBeNull();
    expect(await verifyInstallToken(token, '', NOW)).toBeNull();
  });

  it('stamps the token before the extension and reads it back', async () => {
    const token = (await mintInstallToken(ids, SECRET, NOW))!;
    const stamped = stampAssetName('AntSeed-VPR-Setup-0.2.38.exe', token);
    expect(stamped).toBe(`AntSeed-VPR-Setup-0.2.38.a-${token}.exe`);
    expect(installTokenFromFilename(stamped)).toBe(token);
    expect(installTokenFromFilename(stampAssetName('AntSeed-VPR-0.2.38-arm64.dmg', token))).toBe(token);
    expect(installTokenFromFilename('AntSeed-VPR-Setup-0.2.38.exe')).toBeNull();
    // Browsers append " (1)" to duplicate downloads; the stamp must still parse.
    expect(installTokenFromFilename(`AntSeed-VPR-Setup-0.2.38.a-${token} (1).exe`)).toBeNull();
  });
});
