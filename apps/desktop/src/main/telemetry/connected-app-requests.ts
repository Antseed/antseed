/**
 * Pure matcher for connected-app first-request detection; kept free of
 * Electron imports so it runs under node --test.
 */
/**
 * Requests carry the app's slug or a variant of it (Codex reports
 * `codex-exec`, `codex-desktop`, `codex-cli-rs`), so a variant counts too;
 * `codexfoo` does not.
 */
function toolMatchesSlug(tool: string, slug: string): boolean {
  return tool === slug || tool.startsWith(`${slug}-`);
}

/** True when a conversation for one of `slugs` was active at or after `sinceMs`. */
export function conversationsShowRequestSince(
  conversations: unknown,
  slugs: readonly string[],
  sinceMs: number,
): boolean {
  if (!Array.isArray(conversations) || slugs.length === 0) return false;
  const wanted = slugs.map((slug) => slug.toLowerCase()).filter((slug) => slug.length > 0);
  return conversations.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    return typeof record['tool'] === 'string'
      && wanted.some((slug) => toolMatchesSlug((record['tool'] as string).toLowerCase(), slug))
      && typeof record['lastActiveAt'] === 'number'
      && record['lastActiveAt'] >= sinceMs;
  });
}

export interface FirstRequestWatchOptions {
  /** One look at the proxy: true when the app's request has shown up. */
  check: () => Promise<boolean>;
  /** Called once, when a check finds the request. */
  onSeen: () => void;
  deadlineMs: number;
  pollIntervalMs: number;
  nowMs?: () => number;
}

/**
 * Checks every `pollIntervalMs` and once more at the deadline, so a request
 * that lands after the last regular check still counts before the window
 * closes. A check already running at the deadline is the last one. Returns a
 * function that stops the watch.
 */
export function startFirstRequestWatch(options: FirstRequestWatchOptions): () => void {
  const now = options.nowMs ?? (() => Date.now());
  let stopped = false;
  let checking = false;
  let finalPending = false;
  const stop = (): void => {
    stopped = true;
    clearInterval(interval);
    clearTimeout(finalTimer);
  };
  const runCheck = (final: boolean): void => {
    if (stopped) return;
    if (checking) {
      if (final) finalPending = true;
      return;
    }
    checking = true;
    void options.check()
      .then((seen) => {
        if (stopped || !seen) return;
        stop();
        options.onSeen();
      })
      .catch(() => undefined)
      .finally(() => {
        checking = false;
        if (finalPending && !stopped) {
          finalPending = false;
          runCheck(true);
          return;
        }
        if (final) stop();
      });
  };
  const interval = setInterval(() => {
    if (now() >= options.deadlineMs) return;
    runCheck(false);
  }, options.pollIntervalMs);
  const finalTimer = setTimeout(() => runCheck(true), Math.max(0, options.deadlineMs - now()));
  interval.unref?.();
  finalTimer.unref?.();
  return stop;
}
