/**
 * Long-lived Pi `AgentSession` cache — one session per conversation, kept
 * alive across sends (Pi's own session model, as in Pi interactive mode).
 *
 * An entry is reused only while its fingerprint matches: everything baked
 * into the session at construction (service, peer, route mode, protocol,
 * multimodal flag, proxy port, permission mode, workspace, system prompt,
 * skills). On mismatch the caller disposes it and rebuilds.
 *
 * Session-file writes from `PiConversationStore` go through the cached
 * session's own `SessionManager` (see `attachLiveSessionManager`), so the
 * live session never holds stale entries. Writes that change the LLM context
 * behind Pi's back (image generation turns) `invalidate()` the entry so the
 * next send rebuilds the agent state from the session.
 *
 * Idle entries are disposed after `SESSION_IDLE_TIMEOUT_MS`, never while a
 * run is in flight or Pi is still compacting / retrying.
 */
import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';

export const SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

/** Inputs that are baked into the session at creation time. */
export type SessionFingerprint = {
  serviceId: string;
  peerId: string | null;
  routeMode: 'pinned' | 'auto';
  protocol: string;
  supportsMultimodal: boolean;
  proxyPort: number;
  permissionMode: string;
  workspaceDir: string;
  userSystemPrompt: string;
  skillPaths: string[];
};

export function fingerprintEquals(a: SessionFingerprint, b: SessionFingerprint): boolean {
  return a.serviceId === b.serviceId
    && a.peerId === b.peerId
    && a.routeMode === b.routeMode
    && a.protocol === b.protocol
    && a.supportsMultimodal === b.supportsMultimodal
    && a.proxyPort === b.proxyPort
    && a.permissionMode === b.permissionMode
    && a.workspaceDir === b.workspaceDir
    && a.userSystemPrompt === b.userSystemPrompt
    && a.skillPaths.length === b.skillPaths.length
    && a.skillPaths.every((skillPath, index) => skillPath === b.skillPaths[index]);
}

export type CachedSession = {
  session: AgentSession;
  fingerprint: SessionFingerprint;
  lastUsedAt: number;
  invalidated: boolean;
  /** Settles once an aborted turn's scheduled Pi continuation is neutralized. */
  pendingDrain: Promise<void> | null;
};

export type ChatSessionCacheOptions = {
  /** True while the engine has a run in flight for the conversation. */
  isInUse?: (conversationId: string) => boolean;
  /** Called after an entry's session has been disposed. */
  onDispose?: (conversationId: string, session: AgentSession) => void;
  now?: () => number;
  idleTimeoutMs?: number;
  /** Run the periodic idle sweep (disabled in tests). */
  sweep?: boolean;
};

export class ChatSessionCache {
  private readonly entries = new Map<string, CachedSession>();
  private readonly sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly isInUse: (conversationId: string) => boolean;
  private readonly onDispose: ((conversationId: string, session: AgentSession) => void) | undefined;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;

  constructor(options: ChatSessionCacheOptions = {}) {
    this.isInUse = options.isInUse ?? (() => false);
    this.onDispose = options.onDispose;
    this.now = options.now ?? Date.now;
    this.idleTimeoutMs = options.idleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS;
    if (options.sweep !== false) {
      this.sweepTimer = setInterval(() => this.sweepIdle(), IDLE_SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }

  /** The cached entry, including invalidated ones. */
  peek(conversationId: string): CachedSession | null {
    return this.entries.get(conversationId) ?? null;
  }

  /** The cached entry if it may be reused for `fingerprint`, else null. */
  getReusable(conversationId: string, fingerprint: SessionFingerprint): CachedSession | null {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.invalidated || !fingerprintEquals(entry.fingerprint, fingerprint)) return null;
    entry.lastUsedAt = this.now();
    return entry;
  }

  set(conversationId: string, session: AgentSession, fingerprint: SessionFingerprint): void {
    const previous = this.entries.get(conversationId);
    if (previous && previous.session !== session) this.disposeConversation(conversationId);
    this.entries.set(conversationId, {
      session,
      fingerprint,
      lastUsedAt: this.now(),
      invalidated: false,
      pendingDrain: null,
    });
  }

  touch(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (entry) entry.lastUsedAt = this.now();
  }

  /** Make the next reuse wait for `drain` (see `TurnSettleWaiter.drained`). */
  setPendingDrain(conversationId: string, drain: Promise<void>): void {
    const entry = this.entries.get(conversationId);
    if (!entry) return;
    const tracked: Promise<void> = drain.finally(() => {
      if (entry.pendingDrain === tracked) entry.pendingDrain = null;
    });
    entry.pendingDrain = tracked;
  }

  /** Force the next send to rebuild the session (the entry stays alive until then). */
  invalidate(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (entry) entry.invalidated = true;
  }

  /** Dispose and drop the entry (delete / quit / rebuild). */
  disposeConversation(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (!entry) return;
    this.entries.delete(conversationId);
    try {
      entry.session.dispose();
    } catch {
      // Ignore disposal races.
    }
    this.onDispose?.(conversationId, entry.session);
  }

  disposeAll(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const conversationId of [...this.entries.keys()]) {
      this.disposeConversation(conversationId);
    }
  }

  /** Dispose idle entries; skips sessions mid-run or mid-recovery. */
  sweepIdle(): void {
    const cutoff = this.now() - this.idleTimeoutMs;
    for (const [conversationId, entry] of [...this.entries.entries()]) {
      if (entry.lastUsedAt > cutoff) continue;
      if (this.isInUse(conversationId) || isPiSessionBusy(entry.session)) continue;
      this.disposeConversation(conversationId);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** True while Pi still has work in flight (run, compaction or auto-retry). */
export function isPiSessionBusy(session: AgentSession): boolean {
  return session.isStreaming || session.isCompacting || session.isRetrying;
}

/**
 * How long Pi may sit idle after scheduling an overflow continuation (or
 * with undelivered queued events) before the turn gives up waiting.
 */
export const TURN_SETTLE_STALL_MS = 10_000;
const CONTINUATION_DRAIN_MS = 1_000;

/**
 * Per-turn wait for Pi to go idle, built only on Pi's own events and state.
 *
 * Pi keeps working after `prompt()` resolves: queued session events
 * (`agent_end`) are still being delivered, overflow recovery compacts and
 * then calls `agent.continue()` from a 100 ms timer, and auto-retry may
 * follow. The turn is settled once
 *  - every raw agent `agent_end` has been delivered as a session event,
 *  - no overflow continuation is scheduled (`compaction_end.willRetry`
 *    without the following `agent_start`), and
 *  - Pi reports no run, compaction or retry in flight.
 *
 * Its listeners are independent of the per-turn renderer subscription so an
 * abort that removes that subscription cannot strand the wait. `isAborted`
 * is polled: once the turn is stopped the wait ends with 'Request aborted',
 * and a continuation Pi already scheduled on its timer is aborted as soon as
 * it starts (Pi's `abort()` cannot cancel the timer itself).
 */
export class TurnSettleWaiter {
  private rawAgentEnds = 0;
  private sessionAgentEnds = 0;
  private continuationScheduled = false;
  private overflowCompacting = false;
  private settled = false;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private resolveDone: (() => void) | null = null;
  private readonly done: Promise<void>;
  private readonly unsubscribers: Array<() => void>;
  /**
   * Resolves once nothing this turn scheduled can still start a Pi run.
   * Only differs from settling when the turn is aborted between Pi's
   * `compaction_end { willRetry }` and its timer-started `agent.continue()`.
   */
  drained: Promise<void> = Promise.resolve();
  /** Set when Pi reports that overflow recovery failed or never started. */
  failureMessage: string | null = null;

  constructor(
    private readonly session: AgentSession,
    private readonly isAborted: () => boolean = () => false,
    private readonly stallMs: number = TURN_SETTLE_STALL_MS,
    private readonly pollMs = 50,
  ) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.unsubscribers = [
      session.agent.subscribe((event) => {
        if (event.type === 'agent_end') this.rawAgentEnds += 1;
      }),
      session.subscribe((event) => this.observe(event)),
    ];
  }

  private observe(event: AgentSessionEvent): void {
    if (event.type === 'agent_start') {
      this.continuationScheduled = false;
    } else if (event.type === 'agent_end') {
      this.sessionAgentEnds += 1;
    } else if (event.type === 'compaction_start' && event.reason === 'overflow') {
      this.overflowCompacting = true;
    } else if (event.type === 'compaction_end' && event.reason === 'overflow') {
      this.overflowCompacting = false;
      if (event.willRetry) {
        this.continuationScheduled = true;
      } else if (event.errorMessage) {
        this.failureMessage = event.errorMessage;
      }
    }
    // Pi starts compaction / retry synchronously right after emitting the
    // event, so re-check once the current tick has finished.
    setImmediate(() => this.check());
  }

  /** Resolves once Pi is idle for this turn. Call after `prompt()` resolves. */
  waitUntilSettled(): Promise<void> {
    this.check();
    if (!this.settled && !this.pollTimer) {
      this.pollTimer = setInterval(() => this.check(), this.pollMs);
    }
    return this.done;
  }

  private isTurnWorkRunning(): boolean {
    return this.session.isStreaming || this.session.isRetrying || this.overflowCompacting;
  }

  private check(): void {
    if (this.settled) return;
    if (this.isAborted()) {
      this.handleAbort();
      return;
    }
    const eventsDrained = this.sessionAgentEnds >= this.rawAgentEnds;
    const running = this.isTurnWorkRunning();
    if (eventsDrained && !this.continuationScheduled && !running) {
      this.finish();
      return;
    }
    // Only arm the stall guard while Pi reports no work: compaction and
    // retried runs themselves are not time-limited.
    if (running) {
      this.clearStallTimer();
    } else if (!this.stallTimer) {
      this.stallTimer = setTimeout(() => {
        this.stallTimer = null;
        if (this.settled || this.isTurnWorkRunning()) return;
        if (this.continuationScheduled) {
          this.failureMessage ??= 'AI context overflow recovery did not start.';
        }
        this.finish();
      }, this.stallMs);
    }
  }

  private handleAbort(): void {
    if (this.continuationScheduled || this.overflowCompacting) {
      this.failureMessage = 'Request aborted';
    }
    if (this.continuationScheduled) {
      // Pi's continuation timer cannot be cancelled. Abort the run it starts
      // (raw agent events are synchronous, so this fires before any request
      // goes out) and keep the next send waiting until that has happened.
      const session = this.session;
      this.drained = new Promise<void>((resolve) => {
        let done = false;
        const release = (): void => {
          if (done) return;
          done = true;
          unsubscribe();
          clearTimeout(timer);
          resolve();
        };
        const unsubscribe = session.agent.subscribe((event) => {
          if (event.type !== 'agent_start') return;
          session.agent.abort();
          void session.agent.waitForIdle().finally(release);
        });
        // Pi starts the continuation 100 ms after compaction_end.
        const timer = setTimeout(release, CONTINUATION_DRAIN_MS);
      });
    }
    this.finish();
  }

  /** Release listeners without waiting (e.g. prompt() threw before running). */
  dispose(): void {
    this.finish();
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearStallTimer();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch {
        // Ignore listener cleanup failures.
      }
    }
    this.resolveDone?.();
    this.resolveDone = null;
  }
}

/**
 * Wait for Pi background work (e.g. threshold compaction from the previous
 * turn) to finish before reusing a session. Returns false if Pi is still busy
 * after `timeoutMs`; the caller then rebuilds instead of reusing.
 */
export async function waitForPiSessionIdle(
  session: AgentSession,
  timeoutMs = TURN_SETTLE_STALL_MS,
  pollMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isPiSessionBusy(session)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}
