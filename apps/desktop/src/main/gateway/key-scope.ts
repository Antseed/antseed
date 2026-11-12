import { createHash } from 'node:crypto';

/**
 * Which gateway and key a balance belongs to, so a balance read or cached for
 * one is never shown for another. The key enters only as a digest.
 */
export function gatewayKeyScope(mode: string, origin: string, apiKey: string): string {
  return `${mode} ${origin} ${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
}
