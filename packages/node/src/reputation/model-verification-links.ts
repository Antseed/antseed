import { keccak256, toUtf8Bytes } from 'ethers';
import { verificationServiceKey } from './model-reputation.js';

/**
 * The explorer page of one seller service's verification history
 * (`<explorer>/verification-service/<agentId>~<serviceHash>`), where each
 * recorded verdict links to its audit and evidence. Built locally from the
 * agent id and service name, so it costs no chain read. Null without an
 * explorer URL, a valid agent id or a service name.
 */
export function verificationServiceUrl(
  explorerUrl: string | null | undefined,
  agentId: number | null | undefined,
  serviceId: string,
): string | null {
  const base = explorerUrl?.trim().replace(/\/+$/, '');
  if (!base || typeof agentId !== 'number' || !Number.isSafeInteger(agentId) || agentId <= 0) return null;
  const key = verificationServiceKey(serviceId);
  if (!key) return null;
  return `${base}/verification-service/${agentId}~${keccak256(toUtf8Bytes(key))}`;
}
