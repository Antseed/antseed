// ── Buyer-side cost estimation using tokenx ──────────────────────────

import { estimateTokenCount } from 'tokenx';
import {
  isFreeUnitBillingModel,
  validateUnitBillingModelV1,
} from '@antseed/protocol/billing';

/** Token pricing for a service (USDC per million tokens). */
export interface ServicePricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Price per million cached input tokens. Defaults to inputUsdPerMillion (no discount) if not set. */
  cachedInputUsdPerMillion?: number;
}

export {
  isFreeUnitBillingModel,
  validateUnitBillingModelV1,
};

const textDecoder = new TextDecoder();

/** Estimate token count from raw bytes using tokenx (~95-98% accuracy). */
export function estimateTokensFromBytes(bytes: Uint8Array): number {
  const text = textDecoder.decode(bytes);
  return estimateTokenCount(text);
}

/** Bodies up to this size are estimated in full; larger ones from evenly spaced samples. */
const FULL_ESTIMATE_MAX_BYTES = 64 * 1024;
const SAMPLE_COUNT = 8;
const SAMPLE_BYTES = 8 * 1024;

/**
 * Estimate token count of a possibly large body with bounded CPU. Bodies over 64 KiB are estimated
 * from evenly spaced 8 KiB samples scaled to the full size: tokenx walks every character, and a seller
 * running it over multi-MB request bodies on the event loop spent about half its CPU there and stopped
 * accepting connections. Meant for pre-request checks, not for billing.
 */
export function estimateTokensFromBytesSampled(bytes: Uint8Array): number {
  if (bytes.length <= FULL_ESTIMATE_MAX_BYTES) return estimateTokensFromBytes(bytes);
  const stride = Math.floor((bytes.length - SAMPLE_BYTES) / (SAMPLE_COUNT - 1));
  let sampledTokens = 0;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const start = i * stride;
    sampledTokens += estimateTokensFromBytes(bytes.subarray(start, start + SAMPLE_BYTES));
  }
  return Math.ceil((sampledTokens * bytes.length) / (SAMPLE_COUNT * SAMPLE_BYTES));
}

/** Estimate token count from a string using tokenx. */
export function estimateTokensFromText(text: string): number {
  return estimateTokenCount(text);
}

/**
 * Compute USDC cost in base units (6 decimals) from token counts and pricing.
 * freshInputTokens and cachedInputTokens are independent counts (never overlapping),
 * so they are additive — no subtraction needed. This handles both OpenAI (where the
 * extraction layer splits prompt_tokens) and Anthropic (where input_tokens is fresh-only).
 */
export function computeCostUsdc(
  freshInputTokens: number,
  outputTokens: number,
  pricing: ServicePricing,
  cachedInputTokens = 0,
): bigint {
  const cachedPrice = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
  const freshCost = freshInputTokens * pricing.inputUsdPerMillion;
  const cachedCost = cachedInputTokens * cachedPrice;
  const outputCost = outputTokens * pricing.outputUsdPerMillion;
  const costUsd = (freshCost + cachedCost + outputCost) / 1_000_000;
  const costBaseUnits = Math.max(0, Math.round(costUsd * 1_000_000));
  return BigInt(costBaseUnits);
}

/**
 * Estimate USDC cost from raw content bytes using tokenx token estimation.
 */
export function estimateCostFromBytes(
  inputBytes: Uint8Array,
  outputBytes: Uint8Array,
  pricing: ServicePricing,
): { cost: bigint; inputTokens: number; outputTokens: number } {
  const inputTokens = estimateTokensFromBytes(inputBytes);
  const outputTokens = estimateTokensFromBytes(outputBytes);
  const cost = computeCostUsdc(inputTokens, outputTokens, pricing);
  return { cost, inputTokens, outputTokens };
}
