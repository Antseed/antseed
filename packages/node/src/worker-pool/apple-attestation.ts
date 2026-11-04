import { X509Certificate, createHash } from 'node:crypto';

/**
 * Apple Managed Device Attestation (MDA): an Apple-signed certificate the
 * pool operator's own MDM obtains from an enrolled Mac, vouching for its
 * serial number and security state (docs/protocol/worker-pool.md, "Apple-verified Macs").
 */

/** Apple Enterprise Attestation Root CA (https://www.apple.com/certificateauthority/), SHA-256 CC:F5:9E:F8:…:F0:5B. */
export const APPLE_ENTERPRISE_ATTESTATION_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIICJDCCAamgAwIBAgIUQsDCuyxyfFxeq/bxpm8frF15hzcwCgYIKoZIzj0EAwMw
UTEtMCsGA1UEAwwkQXBwbGUgRW50ZXJwcmlzZSBBdHRlc3RhdGlvbiBSb290IENB
MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzAeFw0yMjAyMTYxOTAx
MjRaFw00NzAyMjAwMDAwMDBaMFExLTArBgNVBAMMJEFwcGxlIEVudGVycHJpc2Ug
QXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UE
BhMCVVMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT6Jigq+Ps9Q4CoT8t8q+UnOe2p
oT9nRaUfGhBTbgvqSGXPjVkbYlIWYO+1zPk2Sz9hQ5ozzmLrPmTBgEWRcHjA2/y7
7GEicps9wn2tj+G89l3INNDKETdxSPPIZpPj8VmjQjBAMA8GA1UdEwEB/wQFMAMB
Af8wHQYDVR0OBBYEFPNqTQGd8muBpV5du+UIbVbi+d66MA4GA1UdDwEB/wQEAwIB
BjAKBggqhkjOPQQDAwNpADBmAjEA1xpWmTLSpr1VH4f8Ypk8f3jMUKYz4QPG8mL5
8m9sX/b2+eXpTv2pH4RZgJjucnbcAjEA4ZSB6S45FlPuS/u4pTnzoz632rA+xW/T
ZwFEh9bhKjJ+5VQ9/Do1os0u3LEkgN/r
-----END CERTIFICATE-----`;

/** Attestation certificate extensions (Apple Platform Security, "Managed Device Attestation"). */
const OID = {
  serialNumber: '1.2.840.113635.100.8.9.1',
  udid: '1.2.840.113635.100.8.9.2',
  osVersion: '1.2.840.113635.100.8.10.1',
  sepOsVersion: '1.2.840.113635.100.8.10.2',
  freshnessCode: '1.2.840.113635.100.8.11.1',
  sipEnabled: '1.2.840.113635.100.8.13.1',
  secureBoot: '1.2.840.113635.100.8.13.2',
  thirdPartyKexts: '1.2.840.113635.100.8.13.3',
} as const;

/** What the pool forwards to buyers: the MDM's DevicePropertiesAttestation answer and the challenge it answered. */
export interface DeviceAttestation {
  /** Base64 DER certificates, leaf first, as the MDM returned them. */
  chain: string[];
  /** The pool's challenge; the freshness code is deviceAttestationNonce(worker, attestationKey, challenge). */
  challenge: string;
}

export interface DeviceAttestationReport {
  serialNumber: string | null;
  udid: string | null;
  osVersion: string | null;
  sipEnabled: boolean | null;
  secureBoot: string | null;
  thirdPartyKexts: boolean | null;
  /** When Apple issued the leaf (unix seconds). */
  issued: number;
}

/**
 * The 32-byte `DeviceAttestationNonce` the pool's MDM sends. It names the
 * worker and its attestation key, so an attestation fetched for one worker
 * can't be presented for another, and buyers can recompute it.
 */
export function deviceAttestationNonce(worker: string, attestationKey: string, challenge: string): Buffer {
  return createHash('sha256')
    .update(`antseed-device-attestation/v1\n${worker.toLowerCase()}\n${attestationKey.toLowerCase()}\n${challenge}`)
    .digest();
}

// ── minimal DER reader: enough to walk to a certificate's extensions ──

interface Tlv { tag: number; start: number; end: number; next: number }

function readTlv(der: Buffer, offset: number): Tlv {
  const tag = der[offset]!;
  let length = der[offset + 1]!;
  let start = offset + 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    if (bytes === 0 || bytes > 4) throw new Error('Unsupported DER length');
    length = 0;
    for (let i = 0; i < bytes; i++) length = length * 256 + der[start + i]!;
    start += bytes;
  }
  const end = start + length;
  if (end > der.length) throw new Error('Truncated DER');
  return { tag, start, end, next: end };
}

function children(der: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let offset = parent.start; offset < parent.end;) {
    const child = readTlv(der, offset);
    out.push(child);
    offset = child.next;
  }
  return out;
}

function decodeOid(bytes: Buffer): string {
  const parts = [Math.floor(bytes[0]! / 40), bytes[0]! % 40];
  let value = 0;
  for (const byte of bytes.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

/** Extension OID → raw extnValue contents. */
function extensions(der: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const tbs = children(der, readTlv(der, 0))[0]!;
  const explicit = children(der, tbs).find((field) => field.tag === 0xa3);
  if (!explicit) return out;
  for (const extension of children(der, children(der, explicit)[0]!)) {
    const fields = children(der, extension);
    const oid = fields[0]!;
    const value = fields[fields.length - 1]!;
    if (oid.tag !== 0x06 || value.tag !== 0x04) continue;
    out.set(decodeOid(der.subarray(oid.start, oid.end)), der.subarray(value.start, value.end));
  }
  return out;
}

function text(value: Buffer | undefined): string | null {
  return value ? value.toString('utf-8') : null;
}

/**
 * Apple documents these flags without their encoding: accept a DER BOOLEAN
 * or INTEGER, a single byte, or "true"/"false" text.
 */
function flag(value: Buffer | undefined): boolean | null {
  if (!value || value.length === 0) return null;
  if ((value[0] === 0x01 || value[0] === 0x02) && value[1] === 0x01 && value.length === 3) return value[2] !== 0;
  if (value.length === 1) return value[0] !== 0 && value[0] !== 0x30;
  const s = value.toString('utf-8').toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return null;
}

export interface DeviceAttestationPolicy {
  worker: string;
  attestationKey: string;
  /** The device the worker says it runs on (from its signed attestation). */
  serialNumber: string;
  /** Oldest acceptable leaf, in seconds before now. */
  maxAgeS: number;
  now?: number;
  /** Trust anchors; Apple's root unless a test overrides it. */
  roots?: string[];
}

/**
 * Verifies an MDA chain: it chains to Apple's root, is fresh, answers this
 * worker's nonce, names the worker's Mac, and reports SIP on.
 */
export function verifyDeviceAttestation(
  attestation: DeviceAttestation,
  policy: DeviceAttestationPolicy,
): { valid: boolean; report?: DeviceAttestationReport; reason?: string } {
  const fail = (reason: string) => ({ valid: false, reason });
  const now = policy.now ?? Math.floor(Date.now() / 1000);
  let certs: X509Certificate[];
  let roots: X509Certificate[];
  try {
    certs = attestation.chain.map((b64) => new X509Certificate(Buffer.from(b64, 'base64')));
    roots = (policy.roots ?? [APPLE_ENTERPRISE_ATTESTATION_ROOT_CA]).map((pem) => new X509Certificate(pem));
  } catch {
    return fail('device attestation is not a certificate chain');
  }
  if (certs.length === 0) return fail('device attestation is empty');

  for (const cert of certs) {
    const from = Date.parse(cert.validFrom) / 1000;
    const to = Date.parse(cert.validTo) / 1000;
    if (!(from <= now + 60 && now <= to)) return fail('device attestation certificate is not valid now');
  }
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i + 1]!.ca || !certs[i]!.checkIssued(certs[i + 1]!) || !certs[i]!.verify(certs[i + 1]!.publicKey)) {
      return fail('device attestation chain is broken');
    }
  }
  const top = certs[certs.length - 1]!;
  const anchored = roots.some((root) => top.raw.equals(root.raw) || (top.checkIssued(root) && top.verify(root.publicKey)));
  if (!anchored) return fail('device attestation does not chain to Apple');

  let ext: Map<string, Buffer>;
  try {
    ext = extensions(certs[0]!.raw);
  } catch {
    return fail('device attestation certificate is malformed');
  }
  const expected = deviceAttestationNonce(policy.worker, policy.attestationKey, attestation.challenge);
  if (!ext.get(OID.freshnessCode)?.equals(expected)) return fail('device attestation answers another challenge');

  const report: DeviceAttestationReport = {
    serialNumber: text(ext.get(OID.serialNumber)),
    udid: text(ext.get(OID.udid)),
    osVersion: text(ext.get(OID.osVersion)),
    sipEnabled: flag(ext.get(OID.sipEnabled)),
    secureBoot: text(ext.get(OID.secureBoot)),
    thirdPartyKexts: flag(ext.get(OID.thirdPartyKexts)),
    issued: Math.floor(Date.parse(certs[0]!.validFrom) / 1000),
  };
  if (report.issued < now - policy.maxAgeS) return fail('device attestation is stale');
  if (report.serialNumber === null || report.serialNumber !== policy.serialNumber) {
    return fail('device attestation is for another Mac');
  }
  if (report.sipEnabled !== true) return { valid: false, report, reason: 'Apple reports SIP off on this Mac' };
  return { valid: true, report };
}

export function isDeviceAttestation(value: unknown): value is DeviceAttestation {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return Array.isArray(a['chain']) && a['chain'].every((c) => typeof c === 'string') && typeof a['challenge'] === 'string';
}
