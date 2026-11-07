// When a testbench should stop by itself. The supervisor is detached, so a `run` killed with SIGKILL (an agent's
// command timeout) never reaches `down`. The pure decisions live here; supervisor.mjs and cli.mjs act on them.

export const WATCHDOG_INTERVAL_MS = 15_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const IDLE_MINUTES_ENV = 'ANTSEED_TESTBENCH_IDLE_MINUTES';
export const DEFAULT_IDLE_MINUTES = 120;

/** The idle budget in minutes, 5 to 1440 like `share --idle`. Read in the CLI: the supervisor's environment is cleaned of ANTSEED_ variables. */
export function resolveIdleMinutes(env = process.env) {
  const raw = env[IDLE_MINUTES_ENV]?.trim();
  if (!raw) return DEFAULT_IDLE_MINUTES;
  if (!(/^\d+$/.test(raw) && Number(raw) >= 5 && Number(raw) <= 1440)) throw new Error(`${IDLE_MINUTES_ENV} must be 5-1440 minutes`);
  return Number(raw);
}

/**
 * `starter` is 'none', 'alive' or 'dead'. A dead starter gets one grace interval after its last heartbeat. A live
 * starter is never idle: a long scenario may not touch the control API for a while.
 */
export function watchdogDecision({ starter, heartbeatAgeMs, lastControlAgeMs, idleMs, graceMs = WATCHDOG_INTERVAL_MS }) {
  if (starter === 'alive') return 'keep';
  if (starter === 'dead') return heartbeatAgeMs >= graceMs ? 'stop:starter-died' : 'keep';
  return lastControlAgeMs >= idleMs ? 'stop:idle' : 'keep';
}

/** What `run` or `up` does with this worktree's testbench: start one, reuse it, or restart one whose `run` died without `down`. */
export function reattachDecision({ running, starter, starterAlive }) {
  if (!running) return 'start';
  return starter && !starterAlive ? 'restart' : 'reuse';
}

/** Calls `beat` now and every `intervalMs` until the returned function runs. A failed beat is only skipped: the supervisor may be stopping. */
export function startHeartbeat(beat, { intervalMs = HEARTBEAT_INTERVAL_MS } = {}) {
  const tick = () => Promise.resolve().then(beat).catch(() => {});
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
