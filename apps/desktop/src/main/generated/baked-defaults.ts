/**
 * Build-time baked defaults.
 *
 * Committed with every value null. Release builds overwrite this file via
 * build-time bake scripts before compiling, so packaged apps carry defaults
 * without hard-coding them in the repo.
 * Runtime environment variables always win over a baked value.
 */

/**
 * Default retail-prices models API URL for the measured-savings baseline.
 * Overridden by ANTSEED_COMPARABLE_PRICES_URL at runtime (an empty value
 * disables the baseline entirely).
 */
export const BAKED_COMPARABLE_PRICES_URL: string | null = null;

/**
 * Public PostHog ingestion configuration for desktop product telemetry.
 * Runtime environment variables override these values; release builds bake
 * them from CI configuration so GUI-launched apps do not depend on shell env.
 */
export const BAKED_POSTHOG_HOST: string | null = null;
export const BAKED_POSTHOG_PROJECT_API_KEY: string | null = null;
