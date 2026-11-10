/**
 * Fail points: named places in the payment path, each between two steps that must both happen for the
 * books to stay consistent (right before or after a durable write or a send). The payment code only
 * reaches a point. Nothing in this repo's packages or apps installs a handler, reads a switch for one
 * or exports a way to set one, so in a shipped build every point returns at once. A test process
 * installs the handler on `globalThis` from outside (the testbench preloads one into the nodes it
 * starts) and decides there what a hit does: nothing, a crash, an error or a delay.
 */

/** What a test process installs under `Symbol.for('antseed.failpoints')` on `globalThis`. */
interface FailpointHandler {
  hit(name: string): Promise<void> | void;
  hitSync(name: string): void;
}

const HANDLER_KEY = Symbol.for('antseed.failpoints');
const NOT_HIT: Promise<void> = Promise.resolve();

function installedHandler(): FailpointHandler | undefined {
  return (globalThis as { [HANDLER_KEY]?: FailpointHandler })[HANDLER_KEY];
}

/**
 * Every fail point, with the two steps it sits between. Points marked (sync) are reached with
 * `hitFailpointSync`, because the code around them runs without yielding and an `await` there would
 * let other work in between; the rest are reached with `hitFailpoint`.
 */
export const FAILPOINTS = [
  // Channel store (sqlite). One pair for every write method; a transaction counts as one write.
  'store.before-write', // (sync) the caller decided to write | the row is written
  'store.after-write', // (sync) the row is written | the caller goes on with the write on disk

  // Chain transactions of AntseedChannels, per operation.
  'chain.reserve.before-send', // the seller holds a verified ReserveAuth | reserve() is broadcast
  'chain.reserve.after-send', // reserve() is broadcast | its receipt is awaited
  'chain.reserve.after-receipt', // reserve() is mined | the seller stores the channel and sends AuthAck
  'chain.top-up.before-send', // the seller holds a verified top-up ReserveAuth | topUp() is broadcast
  'chain.top-up.after-send', // topUp() is broadcast | its receipt is awaited
  'chain.top-up.after-receipt', // topUp() is mined | the seller raises the channel's ceiling
  'chain.settle.before-send', // the seller picked the latest SpendingAuth | settle() is broadcast
  'chain.settle.after-send', // settle() is broadcast | its receipt is awaited
  'chain.settle.after-receipt', // settle() is mined | the seller records the settled amount
  'chain.close.before-send', // the seller picked the final amount | close() is broadcast
  'chain.close.after-send', // close() is broadcast | its receipt is awaited
  'chain.close.after-receipt', // close() is mined | the seller marks the channel settled and answers the buyer
  'chain.request-close.before-send', // the operator decided to exit | requestClose() is broadcast
  'chain.request-close.after-send', // requestClose() is broadcast | its receipt is awaited
  'chain.request-close.after-receipt', // requestClose() is mined | the caller records the close request
  'chain.withdraw.before-send', // the grace period is over | withdraw() is broadcast
  'chain.withdraw.after-send', // withdraw() is broadcast | its receipt is awaited
  'chain.withdraw.after-receipt', // withdraw() is mined | the caller records the channel as timed out

  // Seller request path.
  'seller.response.after-cost-recorded', // (sync) a request's cost is in the seller's books | the NeedAuth for it is built and sent
  'seller.need-auth.before-send', // (sync) a NeedAuth is due (after a response: delivered and cost recorded) | it is sent
  'seller.need-auth.after-send', // (sync) the NeedAuth is sent | the request handler goes on

  // Seller payment manager.
  'seller.spending-auth.after-verify', // (sync) a SpendingAuth passed every check | it is accepted in memory and stored
  'seller.spending-auth.after-store', // (sync) the accepted SpendingAuth is stored | a deferred top-up is scheduled and the result returned
  'seller.top-up.after-verify', // (sync) a top-up ReserveAuth is verified | it is queued for the on-chain topUp()

  // Buyer.
  'buyer.spending-auth.after-sign', // a SpendingAuth is signed | it is persisted (the commit comes before the send)
  'buyer.spending-auth.before-send', // (sync) the SpendingAuth is persisted | it is sent to the seller
  'buyer.spending-auth.after-send', // (sync) the SpendingAuth is sent | the buyer goes on (logs, a top-up)
  'buyer.reserve-auth.before-send', // (sync) an opening or top-up ReserveAuth is persisted | it is sent to the seller
  'buyer.reserve-auth.after-send', // (sync) the ReserveAuth is sent | the buyer adopts the new ceiling in memory
] as const;

export type FailpointName = typeof FAILPOINTS[number];

/** Reaches a fail point in an async path. Without a handler it returns one shared resolved promise. */
export function hitFailpoint(name: FailpointName): Promise<void> {
  const handler = installedHandler();
  if (handler === undefined) return NOT_HIT;
  try {
    return Promise.resolve(handler.hit(name));
  } catch (err) {
    return Promise.reject(err);
  }
}

/** Reaches a fail point where the code around it must not yield. Without a handler it returns at once. */
export function hitFailpointSync(name: FailpointName): void {
  const handler = installedHandler();
  if (handler === undefined) return;
  handler.hitSync(name);
}
