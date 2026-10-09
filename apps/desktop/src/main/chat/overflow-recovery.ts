import { isContextOverflow, type AssistantMessage } from '@mariozechner/pi-ai';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';

/**
 * How long to wait for Pi to move to the next recovery phase when nothing is
 * running yet (compaction not started, or retry not started after compaction).
 * Compaction and the retried run themselves are not time-limited.
 */
export const OVERFLOW_RECOVERY_STALL_MS = 10_000;

export type OverflowRecoveryTransition = 'retry_scheduled' | 'retry_started' | 'recovery_failed' | null;

type Phase = 'idle' | 'awaiting_compaction' | 'compacting' | 'awaiting_retry' | 'retrying' | 'done';

/**
 * Pi recovers from context-overflow errors (including `413 request_too_large`)
 * by compacting the session and calling `agent.continue()` from a timer.
 * `AgentSession.prompt()` resolves before that happens, so the desktop run
 * must keep the session alive until the recovery finishes. This tracker
 * follows the session events and exposes a promise that settles when the
 * recovery is over (retried, failed, aborted, or stalled).
 */
export class OverflowRecoveryTracker {
  private phase: Phase = 'idle';
  private resolveDone: (() => void) | null = null;
  private readonly done: Promise<void>;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  failureMessage: string | null = null;

  constructor(
    private readonly contextWindow: number,
    private readonly compactionEnabled: boolean,
    private readonly stallMs: number = OVERFLOW_RECOVERY_STALL_MS,
  ) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  get pending(): boolean {
    return this.phase !== 'idle' && this.phase !== 'done';
  }

  observe(event: AgentSessionEvent, isRetrying = false): OverflowRecoveryTransition {
    switch (event.type) {
      case 'message_end': {
        const message = event.message as AssistantMessage;
        if (
          (this.phase === 'idle' || this.phase === 'retrying')
          && this.compactionEnabled
          && message.role === 'assistant'
          && message.stopReason === 'error'
          && isContextOverflow(message, this.contextWindow)
        ) {
          this.phase = 'awaiting_compaction';
          this.armStallTimer();
        }
        return null;
      }
      case 'compaction_start':
        if (event.reason === 'overflow' && this.phase === 'awaiting_compaction') {
          this.clearStallTimer();
          this.phase = 'compacting';
        }
        return null;
      case 'compaction_end':
        if (event.reason !== 'overflow' || (this.phase !== 'compacting' && this.phase !== 'awaiting_compaction')) {
          return null;
        }
        if (event.willRetry) {
          this.phase = 'awaiting_retry';
          this.armStallTimer();
          return 'retry_scheduled';
        }
        this.failureMessage = event.errorMessage ?? null;
        this.finish();
        return 'recovery_failed';
      case 'agent_start':
        if (this.phase === 'awaiting_retry' || this.phase === 'retrying') {
          this.clearStallTimer();
          this.phase = 'retrying';
          return 'retry_started';
        }
        return null;
      case 'agent_end': {
        // Pi creates its retry promise before emitting agent_end. A transient
        // error can therefore end this run while another retry is pending.
        const lastAssistant = [...event.messages].reverse()
          .find((message) => message.role === 'assistant') as AssistantMessage | undefined;
        if (this.phase === 'retrying' && (!isRetrying || lastAssistant?.stopReason !== 'error')) this.finish();
        return null;
      }
      case 'auto_retry_end':
        if (this.phase === 'retrying' && !event.success) {
          this.failureMessage = event.finalError ?? 'AI retry failed.';
          this.finish();
          return 'recovery_failed';
        }
        return null;
      default:
        return null;
    }
  }

  /** Resolves immediately when no recovery is in progress. */
  async waitUntilSettled(): Promise<void> {
    if (!this.pending) return;
    await this.done;
  }

  cancel(): void {
    if (this.pending) {
      this.failureMessage = 'Request aborted';
      this.finish();
    }
  }

  private armStallTimer(): void {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      this.failureMessage = 'AI context overflow recovery did not start.';
      this.finish();
    }, this.stallMs);
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private finish(): void {
    this.clearStallTimer();
    this.phase = 'done';
    this.resolveDone?.();
    this.resolveDone = null;
  }
}
