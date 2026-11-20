/**
 * Shutdown budgets shared by the buyer, the gateway and the service files that
 * supervise them. Kept free of imports so the service generator doesn't pull
 * in the proxy and gateway runtimes for a few numbers.
 */

/** On shutdown, buyer requests in flight get this long to finish before their connections are closed. */
export const BUYER_SHUTDOWN_DRAIN_MS = 60_000

/** How long a graceful buyer shutdown may take before the process exits anyway: the proxy's drain, then the node. */
export const BUYER_SHUTDOWN_DEADLINE_MS = BUYER_SHUTDOWN_DRAIN_MS + 15_000

/**
 * The buyer drains requests in flight and closes its payment channels on the
 * way out; the gateway only kills it once its own shutdown deadline has passed.
 */
export const BUYER_STOP_TIMEOUT_MS = BUYER_SHUTDOWN_DEADLINE_MS + 15_000

/** On shutdown, gateway requests in flight get this long to finish before they are closed. */
export const GATEWAY_SHUTDOWN_DRAIN_MS = 60_000
