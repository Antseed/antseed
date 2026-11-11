/**
 * Whether a run's done or error event belongs to a send that a newer one has
 * replaced. `owner` is the send that holds the chat now (none after Stop);
 * `sendId` the send the event's run served (absent from older main processes,
 * whose events are always taken). Only a different, live owner makes it stale:
 * with no owner left, the event still ends its own stopped send.
 */
export function staleStreamEvent(owner: number | undefined, sendId: number | undefined): boolean {
  return sendId !== undefined && owner !== undefined && owner !== sendId;
}
