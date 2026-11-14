import { Contract, getAddress, type AbstractSigner } from 'ethers';
import type { ResponseAuthPayload } from '@antseed/protocol/messages';
import { decodeHttpRequest, decodeHttpResponse } from '@antseed/protocol/request-codec';
import { BaseEvmClient } from './base-evm-client.js';
import { serviceHash } from './verifier-client.js';

export interface TokenizerAuditsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  /** The `AntseedTokenizerAudits` contract. */
  contractAddress: string;
  evmChainId?: number;
}

const RECEIPT_TUPLE =
  '(uint32 version,string requestId,string channelId,address buyer,address seller,string advertisedService,string provider,uint16 statusCode,uint64 responseStartedAt,uint64 responseCompletedAt,bytes signature,bytes request,bytes response)';
const PAIR_TUPLE = `(bytes32 shapeId,${RECEIPT_TUPLE} base,${RECEIPT_TUPLE} probed)`;
const ROUND_TUPLE = `(bytes a,bytes b,${PAIR_TUPLE} suspect,${PAIR_TUPLE}[] references)`;

/** `AntseedTokenizerAudits`: permissionless tokenizer proofs against live-SAME reference sellers. */
export const TOKENIZER_AUDITS_ABI = [
  `function proveTokenizerMismatch(bytes32 modelHash,${ROUND_TUPLE}[] rounds) external`,
  'function shapeIds() external view returns (bytes32[])',
  'function shape(bytes32 shapeId) external view returns ((bytes path,bytes head,bytes mid,bytes tail,bool active))',
  'function serviceModel(bytes32 serviceHash) external view returns (bytes32)',
  'function resolveServices(address[] sellers,string[] services) external view returns (uint256[] agentIds,bytes32[] modelHashes,bool[] liveSame)',
  'function minRounds() external view returns (uint8)',
  'function minReferences() external view returns (uint8)',
  'function tolerance() external view returns (uint32)',
  'function maxRoundSpreadSeconds() external view returns (uint32)',
  'function maxEvidenceAgeSeconds() external view returns (uint32)',
  'function flagClearedAt(uint256 agentId,bytes32 serviceHash) external view returns (uint64)',
  'function validityEpochs() external view returns (uint8)',
  'function creditsPerProof() external view returns (uint32)',
  'function penaltyBps() external view returns (uint256)',
  'function receiptUsed(address seller,string requestId) external view returns (bool)',
  'function flag(uint256 agentId,bytes32 serviceHash) external view returns ((bytes32 modelHash,uint64 epoch,uint64 validUntilEpoch))',
  'function liveFlags(uint256 agentId) external view returns (uint256)',
  'function serviceHashOf(string serviceName) external pure returns (bytes32)',
  `function receiptDigest(${RECEIPT_TUPLE} receipt) external pure returns (bytes32)`,
  'function promptTokensOf(bytes responseBody) external pure returns (bool found,uint256 tokens)',
  'function points(bytes32 channelId,address buyer,address seller,uint256 sellerPoints,uint256 buyerPoints) external view returns (uint256,uint256)',
  'function results() external view returns (address)',
  'function setShape(bytes path,bytes head,bytes mid,bytes tail,bool active) external returns (bytes32)',
  'function setServiceModels(bytes32[] serviceHashes,bytes32 modelHash) external',
  'function setParameters(uint8 rounds,uint8 references,uint32 tolerance,uint32 maxRoundSpreadSeconds) external',
  'function setPenaltyBps(uint256 penaltyBps) external',
  'event TokenizerMismatchProven(uint256 indexed agentId,bytes32 indexed serviceHash,address indexed prover,address seller,bytes32 modelHash,bool usageMisreported,uint256 epoch,int256[] suspectDeltas,int256[] referenceMinDeltas,int256[] referenceMaxDeltas,bytes32 evidenceHash)',
  'event UsageMisreported(uint256 indexed agentId,bytes32 indexed serviceHash,bytes32 modelHash,uint256 validUntilEpoch)',
  'event ProofCredited(uint256 indexed epoch,address indexed prover,uint256 credits)',
  'error InvalidShape()',
  'error InvalidRounds()',
  'error InvalidContent()',
  'error BadSignature()',
  'error NotOk()',
  'error DifferentService()',
  'error ReceiptUsed()',
  'error NotProbePair()',
  'error UsageNotFound()',
  'error UnknownService()',
  'error NotAReference(uint256 round,uint256 referenceIndex)',
  'error ReferencesDisagree(uint256 round)',
  'error WithinTolerance(uint256 round,int256 suspectDelta,int256 referenceMinDelta,int256 referenceMaxDelta)',
  'error RoundTooSpread(uint256 round)',
  'error StaleEvidence(uint256 round)',
  'error FutureEvidence(uint256 round)',
  'error UnknownAgent()',
  'error SelfAudit()',
  'error MalformedRequest()',
  'error MalformedResponse()',
  // From the results layer the proof records into.
  'error InvalidAddress()',
  'error InvalidValue()',
  'error NotAudit()',
] as const;

/** AntseedTokenizerAudits.MAX_ROUNDS and MAX_REFERENCES. */
export const MAX_TOKENIZER_PROOF_ROUNDS = 8;
export const MAX_TOKENIZER_PROOF_REFERENCES = 8;

/**
 * A request shape: a POST to `path` whose body is `head + service + mid + content + tail`, so all sellers in
 * a round read the same prompt and only the model name differs. One per API (Chat Completions, Anthropic
 * Messages, Responses), so every seller is probed in an API it speaks natively.
 */
export interface TokenizerShape {
  shapeId: string;
  path: string;
  head: string;
  mid: string;
  tail: string;
  active: boolean;
}

export interface TokenizerParameters {
  minRounds: number;
  minReferences: number;
  tolerance: number;
  maxRoundSpreadSeconds: number;
}

/** A seller's ResponseAuth with the request and response bytes (binary HTTP codec) it signed. */
export interface SignedReceipt {
  payload: ResponseAuthPayload;
  request: Uint8Array;
  response: Uint8Array;
}

export interface TokenizerProbePair {
  shapeId: string;
  base: SignedReceipt;
  probed: SignedReceipt;
}

export interface TokenizerRound {
  /** Base content (JSON-string-safe). */
  a: string;
  /** Probe content appended to `a` (JSON-string-safe). */
  b: string;
  suspect: TokenizerProbePair;
  references: TokenizerProbePair[];
}

export interface ResolvedService {
  agentId: bigint;
  /** The model the service counts as (its live results status, else the owner mapping); zero when none. */
  modelHash: string;
  /** True when the service has a live SAME and can serve as a reference. */
  liveSame: boolean;
}

/** Uses the same service-name normalization as the results layer. */
export const tokenizerServiceHash: (service: string) => string = serviceHash;

/**
 * Makes `text` safe to sit inside a JSON string as-is, as the contract requires: straight quotes become
 * typographic ones, backslashes become slashes and control characters (newlines included) become spaces.
 */
export function jsonSafeContent(text: string): string {
  return text
    .replace(/"([^"]*)"/g, '“$1”')
    .replace(/"/g, '”')
    .replace(/\\/g, '/')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

/** The request body the contract expects for `service` with `content`. */
export function shapeRequestBody(shape: Pick<TokenizerShape, 'head' | 'mid' | 'tail'>, service: string, content: string): string {
  return shape.head + service + shape.mid + content + shape.tail;
}

/** True when the seller signed exactly the shape's request (path and body) for its advertised service and `content`. */
export function isShapeRequest(
  receipt: SignedReceipt,
  shape: Pick<TokenizerShape, 'path' | 'head' | 'mid' | 'tail'>,
  content: string,
): boolean {
  const request = decodeHttpRequest(receipt.request);
  return request.path === shape.path
    && equal(request.body, new TextEncoder().encode(shapeRequestBody(shape, receipt.payload.advertisedService, content)));
}

/**
 * The prompt tokens a signed response body reports, read exactly as the contract does: inside the one
 * top-level `usage` object, one `"prompt_tokens"`, else one `"input_tokens"` plus at most one of each
 * Anthropic cache key. Nested breakdowns (e.g. Responses' per-item usage) and text are ignored. Null when
 * the body has no single usage field.
 */
export function promptTokensOfBody(body: Uint8Array): number | null {
  const counts = new Map<string, number[]>();
  let objects = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let inUsage = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === BACKSLASH) escaped = true;
      else if (c === QUOTE) inString = false;
      continue;
    }
    if (c === OPEN_BRACE || c === OPEN_BRACKET) {
      depth++;
    } else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
      if (depth === 2 && inUsage) inUsage = false;
      if (depth !== 0) depth--;
    } else if (c === QUOTE) {
      const usageObject = depth === 1 ? usageObjectAfter(body, i) : 0;
      if (usageObject !== 0) {
        objects++;
        inUsage = true;
        depth = 2;
        i = usageObject;
        continue;
      }
      const key = depth === 2 && inUsage ? usageKeyAt(body, i) : null;
      if (key) {
        counts.set(key.name, [...(counts.get(key.name) ?? []), key.value]);
        i = key.end - 1;
      } else {
        inString = true;
      }
    }
  }
  if (objects !== 1) return null;
  const values = (name: string) => counts.get(name) ?? [];
  const prompt = values('prompt_tokens');
  if (prompt.length === 1) return prompt[0]!;
  const input = values('input_tokens');
  const read = values('cache_read_input_tokens');
  const creation = values('cache_creation_input_tokens');
  if (prompt.length > 1 || input.length !== 1 || read.length > 1 || creation.length > 1) return null;
  return input[0]! + (read[0] ?? 0) + (creation[0] ?? 0);
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const COMMA = 0x2c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COLON = 0x3a;
const USAGE_KEYS = ['prompt_tokens', 'input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const MAX_TOKEN_DIGITS = 15;

/** If a `"usage"` key whose value is an object starts at `offset`, the offset of that `{`; else 0. */
function usageObjectAfter(body: Uint8Array, offset: number): number {
  let end = quotedKeyEnd(body, offset, 'usage');
  if (end === 0) return 0;
  end = skipSpace(body, end);
  if (body[end] !== COLON) return 0;
  end = skipSpace(body, end + 1);
  return body[end] === OPEN_BRACE ? end : 0;
}

/** The usage key starting at `offset` when it is followed by a colon and a number. */
function usageKeyAt(body: Uint8Array, offset: number): { name: string; value: number; end: number } | null {
  for (const name of USAGE_KEYS) {
    const end = quotedKeyEnd(body, offset, name);
    if (end === 0) continue;
    let at = skipSpace(body, end);
    if (body[at] !== COLON) return null;
    at = skipSpace(body, at + 1);
    let digits = 0;
    let value = 0;
    while (at < body.length && body[at]! >= 0x30 && body[at]! <= 0x39) {
      if (++digits > MAX_TOKEN_DIGITS) return null;
      value = value * 10 + (body[at]! - 0x30);
      at++;
    }
    // A decimal or exponent is not a token count: the number must end the member.
    at = skipSpace(body, at);
    if (digits === 0 || (body[at] !== COMMA && body[at] !== CLOSE_BRACE)) return null;
    return { name, value, end };
  }
  return null;
}

/** The offset after `"name"` when it starts at `offset`; else 0. */
function quotedKeyEnd(body: Uint8Array, offset: number, name: string): number {
  if (body[offset] !== QUOTE || offset + name.length + 2 > body.length) return 0;
  for (let j = 0; j < name.length; j++) if (body[offset + 1 + j] !== name.charCodeAt(j)) return 0;
  return body[offset + 1 + name.length] === QUOTE ? offset + name.length + 2 : 0;
}

/** JSON whitespace plus the vertical tab and form feed, as the contract skips them. */
function skipSpace(body: Uint8Array, offset: number): number {
  while (offset < body.length && [0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c].includes(body[offset]!)) offset++;
  return offset;
}

/** The prompt tokens of a signed receipt's response, or null when it reports none the contract can read. */
export function receiptPromptTokens(receipt: SignedReceipt): number | null {
  const response = decodeHttpResponse(receipt.response);
  if (response.statusCode !== 200) return null;
  return promptTokensOfBody(response.body);
}

/** The prompt-token difference a pair's signed responses report; null when either has no readable usage. */
export function pairDelta(pair: TokenizerProbePair): number | null {
  const base = receiptPromptTokens(pair.base);
  const probed = receiptPromptTokens(pair.probed);
  return base === null || probed === null ? null : probed - base;
}

/** The tuple `AntseedResponseAuth.Receipt` takes. */
export function receiptTuple(receipt: SignedReceipt): unknown[] {
  const p = receipt.payload;
  const signature = p.signature.startsWith('0x') ? p.signature : `0x${p.signature}`;
  return [
    p.version,
    p.requestId,
    p.channelId ?? '',
    getAddress(withHexPrefix(p.buyerPeerId)),
    getAddress(withHexPrefix(p.sellerPeerId)),
    p.advertisedService,
    p.provider,
    p.statusCode,
    BigInt(p.responseStartedAt),
    BigInt(p.responseCompletedAt),
    signature,
    receipt.request,
    receipt.response,
  ];
}

export function pairTuple(pair: TokenizerProbePair): unknown[] {
  return [pair.shapeId, receiptTuple(pair.base), receiptTuple(pair.probed)];
}

export function roundTuple(round: TokenizerRound): unknown[] {
  const encoder = new TextEncoder();
  return [encoder.encode(round.a), encoder.encode(round.b), pairTuple(round.suspect), round.references.map(pairTuple)];
}

/**
 * Reads shapes, parameters and reference eligibility from `AntseedTokenizerAudits`, and submits proofs.
 * Proving is permissionless: any signer may call `proveTokenizerMismatch`.
 */
export class TokenizerAuditsClient extends BaseEvmClient {
  private _contractInstance: Contract | null = null;

  constructor(config: TokenizerAuditsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private _contract(): Contract {
    this._contractInstance ??= new Contract(this._contractAddress, TOKENIZER_AUDITS_ABI, this._provider);
    return this._contractInstance;
  }

  /** The registered request shapes provers may use (active ones only). */
  async activeShapes(): Promise<TokenizerShape[]> {
    const ids = (await this._contract().getFunction('shapeIds')()) as string[];
    const decoder = new TextDecoder();
    const text = (hex: unknown) => decoder.decode(hexBytes(String(hex)));
    const shapes = await Promise.all(ids.map(async (id) => {
      const shape = await this._contract().getFunction('shape')(id);
      return {
        shapeId: String(id),
        path: text(shape.path),
        head: text(shape.head),
        mid: text(shape.mid),
        tail: text(shape.tail),
        active: Boolean(shape.active),
      };
    }));
    return shapes.filter((shape) => shape.active);
  }

  async parameters(): Promise<TokenizerParameters> {
    const c = this._contract();
    const [minRounds, minReferences, tolerance, maxRoundSpreadSeconds] = await Promise.all([
      c.getFunction('minRounds')(),
      c.getFunction('minReferences')(),
      c.getFunction('tolerance')(),
      c.getFunction('maxRoundSpreadSeconds')(),
    ]);
    return {
      minRounds: Number(minRounds),
      minReferences: Number(minReferences),
      tolerance: Number(tolerance),
      maxRoundSpreadSeconds: Number(maxRoundSpreadSeconds),
    };
  }

  /** Agent, model and reference eligibility of each (seller, service), in chunks of 200. */
  async resolveServices(entries: ReadonlyArray<{ seller: string; service: string }>): Promise<ResolvedService[]> {
    const out: ResolvedService[] = [];
    for (let i = 0; i < entries.length; i += 200) {
      const chunk = entries.slice(i, i + 200);
      const [agentIds, modelHashes, liveSame] = await this._contract().getFunction('resolveServices')(
        chunk.map((e) => getAddress(withHexPrefix(e.seller))),
        chunk.map((e) => e.service),
      ) as [bigint[], string[], boolean[]];
      chunk.forEach((_, index) => out.push({
        agentId: BigInt(agentIds[index]!),
        modelHash: String(modelHashes[index]),
        liveSame: Boolean(liveSame[index]),
      }));
    }
    return out;
  }

  async receiptUsed(seller: string, requestId: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('receiptUsed')(getAddress(withHexPrefix(seller)), requestId));
  }

  /**
   * Simulates the proof as `from` and returns null when it would succeed, else the contract's error
   * (e.g. `WithinTolerance(1, 139, 139)`), so a prover never pays gas for a proof that reverts.
   */
  async checkProof(from: string, modelHash: string, rounds: readonly TokenizerRound[]): Promise<string | null> {
    try {
      await this._contract().getFunction('proveTokenizerMismatch').staticCall(modelHash, rounds.map(roundTuple), { from });
      return null;
    } catch (err) {
      const failure = err as { revert?: { name?: string; args?: unknown[] }; shortMessage?: string; data?: string };
      if (failure.revert?.name) return `${failure.revert.name}(${(failure.revert.args ?? []).map(String).join(', ')})`;
      if (typeof failure.data === 'string' && failure.data.length >= 10) return `reverted with ${failure.data.slice(0, 10)}`;
      return failure.shortMessage ?? (err instanceof Error ? err.message : String(err));
    }
  }

  /** Submits a proof; returns the transaction hash. */
  async proveTokenizerMismatch(signer: AbstractSigner, modelHash: string, rounds: readonly TokenizerRound[]): Promise<string> {
    if (rounds.length === 0 || rounds.length > MAX_TOKENIZER_PROOF_ROUNDS) throw new Error('invalid number of rounds');
    return this._execWrite(signer, TOKENIZER_AUDITS_ABI, 'proveTokenizerMismatch', modelHash, rounds.map(roundTuple));
  }
}

function withHexPrefix(value: string): string {
  return value.startsWith('0x') ? value : `0x${value}`;
}

function hexBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
