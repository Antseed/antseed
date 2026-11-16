import type { GithubVerificationClaim, PeerMetadata } from "./peer-metadata.js";
import { fetchPublicProof } from '../reputation/public-json.js';
import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  MAX_VERIFICATION_PROOF_BYTES,
  formatError,
  normalizePeerId,
  readBodyWithLimit,
  withTimeoutSignal,
} from "./verification-utils.js";

export const GITHUB_VERIFICATION_PROOF_FILE = "antseed.json";
export const GITHUB_VERIFICATION_PROOF_TYPE = "antseed-github-verification";

export interface GithubVerificationResult {
  username: string;
  repository: string;
  peerId: string;
  verified: boolean;
  checkedAtMs: number;
  error?: string;
}

export interface GithubVerificationOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

interface GithubProof {
  type?: unknown;
  peerId?: unknown;
  username?: unknown;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function resolveRepository(claim: GithubVerificationClaim): string {
  const repository = claim.repository ? normalizeName(claim.repository) : "";
  return repository || normalizeName(claim.username);
}

/**
 * URL of the proof document for a claim. Ownership is bound by the username
 * in the `raw.githubusercontent.com` path: only the account owner can place
 * a file in a repository under that path.
 */
export function buildGithubVerificationProofUrl(claim: GithubVerificationClaim): string {
  const username = normalizeName(claim.username);
  return `https://raw.githubusercontent.com/${username}/${resolveRepository(claim)}/HEAD/${GITHUB_VERIFICATION_PROOF_FILE}`;
}

export function buildGithubVerificationProof(peerId: string, username: string): {
  type: typeof GITHUB_VERIFICATION_PROOF_TYPE;
  peerId: string;
  username: string;
} {
  return {
    type: GITHUB_VERIFICATION_PROOF_TYPE,
    peerId: normalizePeerId(peerId),
    username: normalizeName(username),
  };
}

export async function verifyGithubVerificationClaim(
  claim: GithubVerificationClaim,
  peerId: string,
  options?: GithubVerificationOptions,
): Promise<GithubVerificationResult> {
  const normalizedPeerId = normalizePeerId(peerId);
  const username = normalizeName(claim.username);
  const repository = resolveRepository(claim);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  const { signal, cleanup } = withTimeoutSignal(options?.signal, timeoutMs);
  const base = {
    username,
    repository,
    peerId: normalizedPeerId,
  };
  try {
    if (!/^[a-z0-9-]{1,39}$/i.test(username) || !/^[a-z0-9._-]{1,100}$/i.test(repository) || repository === '.' || repository === '..') {
      throw new Error('Invalid GitHub claim');
    }
    // redirect: "error" keeps the proof pinned to the claimed account: a
    // renamed or transferred repository must re-publish the proof under the
    // claimed username rather than verify through a redirect.
    const response = await (options?.fetch ?? fetchPublicProof)(buildGithubVerificationProofUrl(claim), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      return { ...base, verified: false, checkedAtMs: Date.now(), error: `HTTP ${response.status}` };
    }
    const proof = JSON.parse(await readBodyWithLimit(response, MAX_VERIFICATION_PROOF_BYTES)) as GithubProof;
    if (proof.type !== GITHUB_VERIFICATION_PROOF_TYPE) {
      return { ...base, verified: false, checkedAtMs: Date.now(), error: "Proof type mismatch" };
    }
    const proofPeerId = typeof proof.peerId === "string" ? normalizePeerId(proof.peerId) : "";
    if (proofPeerId !== normalizedPeerId) {
      return { ...base, verified: false, checkedAtMs: Date.now(), error: "Proof peerId mismatch" };
    }
    const proofUsername = typeof proof.username === "string" ? normalizeName(proof.username) : "";
    if (proofUsername !== username) {
      return { ...base, verified: false, checkedAtMs: Date.now(), error: "Proof username mismatch" };
    }
    return { ...base, verified: true, checkedAtMs: Date.now() };
  } catch (err) {
    return { ...base, verified: false, checkedAtMs: Date.now(), error: formatError(err) };
  } finally {
    cleanup();
  }
}

export async function verifyPeerMetadataGithub(
  metadata: PeerMetadata,
  options?: GithubVerificationOptions,
): Promise<GithubVerificationResult[]> {
  const claims = metadata.verifications?.github ?? [];
  return Promise.all(
    claims.map((claim) => verifyGithubVerificationClaim(claim, metadata.peerId, options)),
  );
}
