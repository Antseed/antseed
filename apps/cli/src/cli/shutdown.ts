type ShutdownCallback = () => Promise<void>;

let shutdownCallbacks: ShutdownCallback[] = [];
let isShuttingDown = false;
let exitCode = 0;
let runShutdown: (() => Promise<void>) | null = null;

/**
 * Register a callback to be called on shutdown (SIGINT/SIGTERM).
 * Multiple callbacks are called in LIFO order (last registered = first called).
 * The process exits after all callbacks complete.
 *
 * @param callback - Async function to run during shutdown
 */
export function setupShutdownHandler(callback: ShutdownCallback): void {
  shutdownCallbacks.push(callback);

  // Only register signal handlers once
  if (shutdownCallbacks.length === 1) {
    const handler = async () => {
      if (isShuttingDown) return; // Prevent double-shutdown
      isShuttingDown = true;

      // Execute callbacks in LIFO order
      const callbacks = [...shutdownCallbacks].reverse();
      for (const cb of callbacks) {
        try {
          await cb();
        } catch (err) {
          console.error('Shutdown error:', (err as Error).message);
        }
      }

      process.exit(exitCode);
    };
    runShutdown = handler;

    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  }
}

/** Exit code for a restart a supervisor should carry out (systemd `Restart=on-failure` restarts on it; Kubernetes on any exit). */
export const RESTART_EXIT_CODE = 75;

/** Whether the shutdown under way is a restart (state a restart reuses is kept). */
export function isRestarting(): boolean {
  return exitCode === RESTART_EXIT_CODE;
}

/** Shuts down like SIGTERM, then exits with `RESTART_EXIT_CODE` so the supervisor starts the process again. */
export function shutdownForRestart(): void {
  exitCode = RESTART_EXIT_CODE;
  void runShutdown?.();
}
