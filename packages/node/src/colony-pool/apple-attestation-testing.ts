import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

/**
 * A stand-in for Apple's attestation CA, for tests only: issues chains shaped
 * like Managed Device Attestation (root → intermediate → leaf with Apple's
 * extensions) so verifiers can be exercised without a real Mac and MDM.
 */

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

const seq = (...parts: Buffer[]) => der(0x30, ...parts);

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a! * 40 + b!];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function time(date: Date): Buffer {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return der(0x17, Buffer.from(`${s}Z`));
}

const name = (cn: string) => seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn)))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function extension(id: string, value: Buffer, critical = false): Buffer {
  return seq(oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
}

interface Issued { cert: Buffer; key: KeyObject }

function certificate(subject: string, issuer: string, publicKey: KeyObject, signer: KeyObject, extensions: Buffer[], notBefore: Date, serial: number): Buffer {
  const notAfter = new Date(notBefore.getTime() + 365 * 24 * 3600_000);
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([serial])),
    ECDSA_SHA256,
    name(issuer),
    seq(time(notBefore), time(notAfter)),
    name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(...extensions)),
  );
  return seq(tbs, ECDSA_SHA256, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, { key: signer, dsaEncoding: 'der' })])));
}

const toPem = (cert: Buffer) => `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

export interface TestDeviceAttestationOptions {
  serialNumber: string;
  udid: string;
  nonce: Uint8Array;
  sip?: boolean;
  notBefore?: Date;
}

/** `created`: when the root and intermediate start being valid (each for 365 days); an hour ago by default. */
export function createTestAppleCa(opts: { created?: Date } = {}): { rootPem: string; issue(opts: TestDeviceAttestationOptions): string[] } {
  const ca = [seq(der(0x01, Buffer.from([0xff])))].map((value) => extension('2.5.29.19', value, true));
  const newKey = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rootKeys = newKey();
  const created = opts.created ?? new Date(Date.now() - 3600_000);
  const root: Issued = { cert: certificate('Test Attestation Root', 'Test Attestation Root', rootKeys.publicKey, rootKeys.privateKey, ca, created, 1), key: rootKeys.privateKey };
  const subKeys = newKey();
  const sub: Issued = { cert: certificate('Test Attestation Sub CA', 'Test Attestation Root', subKeys.publicKey, root.key, ca, created, 2), key: subKeys.privateKey };
  return {
    rootPem: toPem(root.cert),
    issue(opts) {
      const leafKeys = newKey();
      const leaf = certificate('Test Device', 'Test Attestation Sub CA', leafKeys.publicKey, sub.key, [
        extension('1.2.840.113635.100.8.9.1', Buffer.from(opts.serialNumber)),
        extension('1.2.840.113635.100.8.9.2', Buffer.from(opts.udid)),
        extension('1.2.840.113635.100.8.10.1', Buffer.from('26.2')),
        extension('1.2.840.113635.100.8.11.1', Buffer.from(opts.nonce)),
        extension('1.2.840.113635.100.8.13.1', der(0x01, Buffer.from([opts.sip === false ? 0 : 0xff]))),
      ], opts.notBefore ?? new Date(Date.now() - 1000), 3);
      return [leaf.toString('base64'), sub.cert.toString('base64')];
    },
  };
}
