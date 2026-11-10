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

/** `--timeout` default: how long a start may take, in seconds, before the supervisor fails it. */
export const DEFAULT_START_TIMEOUT_SECONDS = 600;
/** How often a starting supervisor checks its deadline and its starter. */
export const STARTUP_WATCH_INTERVAL_MS = 5000;

/**
 * Whether a supervisor that is still starting gives up. No step of the start may wait forever: past `timeoutMs` the
 * start fails, whatever it is waiting for. A start nobody waits for any more (`starter` 'dead') stops too, without a
 * grace interval: there is no heartbeat before READY, and nothing is settled or lost by stopping.
 */
export function startupDecision({ starter, elapsedMs, timeoutMs }) {
  if (elapsedMs >= timeoutMs) return 'stop:start-timeout';
  return starter === 'dead' ? 'stop:starter-died' : 'keep';
}

/**
 * What `down` does with a testbench whose supervisor holds the lock but serves no control API. `manifest` counts only
 * when that supervisor wrote it. 'wait': its shutdown is already under way (a failed start, or a stop that just closed
 * the control API). 'stop': it is still starting and the `run` or `up` that started it is gone, so nobody waits for it.
 * 'refuse': it is still starting for a starter that is alive, or has not said yet who started it (no manifest of its own
 * yet, or no recorded starter).
 */
export function startingDecision({ manifest, holder, starterAlive }) {
  const own = Boolean(manifest?.supervisor) && manifest.supervisor.pid === holder?.pid && manifest.supervisor.startedAt === holder?.startedAt;
  if (!own) return 'refuse';
  if (manifest.stoppingAt || manifest.startError || manifest.stoppedAt) return 'wait';
  return manifest.starting && manifest.starter && !starterAlive ? 'stop' : 'refuse';
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
