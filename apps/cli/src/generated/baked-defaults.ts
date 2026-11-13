/**
 * Build-time baked defaults.
 *
 * Committed with every value null. Release builds overwrite this file via
 * `node scripts/bake-comparable-prices-url.mjs` before compiling, so
 * published artifacts carry defaults without hard-coding them in the repo.
 * Runtime environment variables always win over a baked value.
 */

/**
 * Default retail-prices models API URL for the measured-savings baseline.
 * Overridden by ANTSEED_COMPARABLE_PRICES_URL at runtime (an empty value
 * disables the baseline entirely).
 */
export const BAKED_COMPARABLE_PRICES_URL: string | null = null;

/**
 * Public PostHog ingestion configuration for CLI, buyer and gateway product
 * telemetry (docs/telemetry.md). Null in source builds, which therefore send
 * nothing. Release builds bake them with
 * `node scripts/bake-desktop-telemetry-config.mjs`. POSTHOG_HOST and
 * POSTHOG_PROJECT_API_KEY override them at runtime.
 */
export const BAKED_POSTHOG_HOST: string | null = null;
export const BAKED_POSTHOG_PROJECT_API_KEY: string | null = null;
