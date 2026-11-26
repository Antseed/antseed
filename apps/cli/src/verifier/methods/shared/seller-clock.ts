/**
 * The audited seller's clock, the same for every test (`LazyAuditDeadline` in `model-run.ts`): it runs only while a
 * request to the seller is out, as for question batches, so the auditor's own waiting (the reference, a free request
 * slot, the model's other sellers) is never counted as the seller's silence.
 */
export interface SellerClock {
  /** Aborted when the audit stops: the seller was silent too long, or the audit's longest time is up. */
  signal: AbortSignal
  /** A request to the seller goes out; returns the signal it stops on. */
  start(): AbortSignal
  /** That request came back; `answered` when the seller answered it. */
  finish(answered: boolean): void
}
