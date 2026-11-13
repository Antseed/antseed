/**
 * Browser-side connection auth: builds the signed hello envelope using the
 * shared wire format from @antseed/protocol.
 */

import { Wallet, type Signer } from 'ethers';
import {
  MSG_SIGNING_DOMAIN,
  buildConnectionAuthPayload,
  type ConnectionAuthEnvelope,
} from '@antseed/protocol/connection-auth';

export type { ConnectionAuthEnvelope };

export function signerFromPrivateKey(privateKeyHex: string): Wallet {
  const key = privateKeyHex.startsWith('0x') ? privateKeyHex : `0x${privateKeyHex}`;
  return new Wallet(key);
}

export async function peerIdOf(signer: Signer): Promise<string> {
  return (await signer.getAddress()).slice(2).toLowerCase();
}

export async function buildHelloEnvelope(signer: Signer): Promise<ConnectionAuthEnvelope> {
  const peerId = await peerIdOf(signer);
  const ts = Date.now();
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = [...nonceBytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const payload = buildConnectionAuthPayload('hello', peerId, ts, nonce);
  const sig = (await signer.signMessage(MSG_SIGNING_DOMAIN + payload)).slice(2).toLowerCase();
  return { peerId, ts, nonce, sig };
}
