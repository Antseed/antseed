import { assertRoutingPreferences } from '@antseed/node';

export const LEVANTO_ROUTING_PATH = '/_antseed/levanto-route';
export const MAX_ROUTING_CANDIDATES = 512;
export type AllowedRoutingCandidate = { peerId: string; provider: string; serviceId: string };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function peerId(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export function validateRoutingRequest(input: unknown): asserts input is Record<string, unknown> {
  if (!object(input) || input.v !== 1
    || typeof input.inputMessage !== 'string' || !input.inputMessage.trim()
    || !Number.isSafeInteger(input.promptTokens) || (input.promptTokens as number) < 0
    || !Array.isArray(input.expectedCachedTokens) || !object(input.constraints)) {
    throw new Error('Invalid Levanto routing request');
  }
  assertRoutingPreferences(input.preferences);
  if (Object.keys(input).some(key => !['v', 'preferences', 'inputMessage', 'promptTokens', 'expectedCachedTokens', 'constraints', 'service', 'catalogRevision'].includes(key))) throw new Error('Unsupported routing request field');
  if (Object.keys(input.constraints).some(key => !['allowedCandidates', 'allowedPeerIds', 'blockedPeerIds', 'maxInputUsdPerMillion', 'minTrustScore'].includes(key))) throw new Error('Unsupported routing constraint');
  if (input.catalogRevision !== undefined && (typeof input.catalogRevision !== 'string' || !input.catalogRevision || input.catalogRevision.length > 128)) throw new Error('Invalid catalog revision');
  const candidates = input.constraints.allowedCandidates;
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > MAX_ROUTING_CANDIDATES) throw new Error('Invalid allowed candidates');
  const keys = new Set<string>();
  for (const candidate of candidates) {
    if (!object(candidate) || Object.keys(candidate).some(key => !['peerId', 'provider', 'serviceId'].includes(key))
      || !peerId(candidate.peerId) || !identifier(candidate.provider) || !identifier(candidate.serviceId)) throw new Error('Invalid allowed candidate');
    const key = JSON.stringify([candidate.peerId, candidate.provider, candidate.serviceId]);
    if (keys.has(key)) throw new Error('Duplicate allowed candidate');
    keys.add(key);
  }
  for (const entry of input.expectedCachedTokens) {
    if (!object(entry) || typeof entry.model !== 'string' || !entry.model || !peerId(entry.peer)
      || !Number.isSafeInteger(entry.tokens) || (entry.tokens as number) < 0) throw new Error('Invalid cached-token estimate');
  }
  for (const key of ['maxInputUsdPerMillion', 'minTrustScore']) {
    if (input.constraints[key] !== undefined && !nonnegative(input.constraints[key])) throw new Error(`Invalid constraint ${key}`);
  }
  for (const key of ['allowedPeerIds', 'blockedPeerIds']) {
    const values = input.constraints[key];
    if (values !== undefined && (!Array.isArray(values) || !values.every(peerId))) throw new Error(`Invalid constraint ${key}`);
  }
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && new TextEncoder().encode(value).length <= 64 && !/[\u0000-\u001f\u007f*]/.test(value);
}

export function validateRoutingResponse(input: unknown, request: unknown): Array<{ model: string; peer: string; provider: string }> {
  validateRoutingRequest(request);
  if (!object(input) || input.v !== 1 || input.catalogRevision !== request.catalogRevision || input.error !== undefined || input.renewalDue !== undefined
    || typeof input.router !== 'string' || !input.router || !Array.isArray(input.ranked) || !input.ranked.length || input.ranked.length > 512) {
    throw new Error('Invalid Levanto routing response; per-response backend required');
  }
  const constraints = request.constraints as Record<string, unknown>;
  const accepted: Array<{ model: string; peer: string; provider: string }> = [];
  for (const entry of input.ranked) {
    if (!object(entry) || typeof entry.model !== 'string' || !entry.model || !peerId(entry.peer) || entry.inference !== undefined
      || !object(entry.estimate) || !object(entry.price)
      || !['costUsd', 'inputTokens', 'cachedInputTokens', 'outputTokens'].every(key => nonnegative(entry.estimate && (entry.estimate as Record<string, unknown>)[key]))
      || !['inUsdPerM', 'outUsdPerM', 'cachedInUsdPerM'].every(key => nonnegative(entry.price && (entry.price as Record<string, unknown>)[key]))) {
      continue;
    }
    if ((Array.isArray(constraints.allowedPeerIds) && constraints.allowedPeerIds.length > 0 && !constraints.allowedPeerIds.includes(entry.peer))
      || (Array.isArray(constraints.blockedPeerIds) && constraints.blockedPeerIds.includes(entry.peer))
      || (typeof constraints.maxInputUsdPerMillion === 'number' && (entry.price.inUsdPerM as number) > constraints.maxInputUsdPerMillion)) {
      continue;
    }
    if (!identifier(entry.provider) || !(constraints.allowedCandidates as AllowedRoutingCandidate[]).some(candidate =>
      candidate.peerId === entry.peer && candidate.provider === entry.provider && candidate.serviceId === entry.model)) throw new Error('Router returned a destination outside allowed candidates');
    accepted.push({ model: entry.model as string, peer: entry.peer as string, provider: entry.provider });
  }
  if (!accepted.length) throw new Error('No valid recommendations satisfy routing constraints');
  return accepted;
}
