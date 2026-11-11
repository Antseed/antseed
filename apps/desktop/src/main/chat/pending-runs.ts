/**
 * Chat runs still in preflight (privacy gate, gateway, model and session
 * setup), before they become an ActiveRun with a session to abort. Each is
 * registered before its first await, so a Stop that arrives during preflight
 * cancels it and the prompt never goes out.
 */
export class PendingRuns {
  private readonly runs = new Map<string, AbortController>();

  /** Starts a run for the conversation, cancelling one already pending there. */
  begin(conversationId: string): { signal: AbortSignal; end: () => void } {
    this.runs.get(conversationId)?.abort();
    const controller = new AbortController();
    this.runs.set(conversationId, controller);
    return {
      signal: controller.signal,
      end: () => {
        if (this.runs.get(conversationId) === controller) this.runs.delete(conversationId);
      },
    };
  }

  /** Cancels the conversation's pending run, or every pending run without an id. */
  abort(conversationId?: string): void {
    const controllers = conversationId
      ? [this.runs.get(conversationId)].filter((run): run is AbortController => Boolean(run))
      : Array.from(this.runs.values());
    for (const controller of controllers) controller.abort();
  }
}
