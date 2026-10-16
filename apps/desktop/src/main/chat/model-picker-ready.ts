/**
 * Resolves once the renderer's first model-picker snapshot reaches main, so
 * launch-time work that lists those models (connected-app config patches)
 * does not write before the list exists. Waiters give up after a timeout and
 * proceed with whatever is cached, so a renderer that never pushes (offline,
 * empty catalog) cannot stall launch.
 */
export interface ModelPickerReadyGate {
  markReady(): void;
  /** True when the snapshot arrived, false when the wait timed out. */
  waitForReady(timeoutMs: number): Promise<boolean>;
}

export function createModelPickerReadyGate(): ModelPickerReadyGate {
  let ready = false;
  let resolveReady: () => void = () => undefined;
  const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });
  return {
    markReady() {
      if (ready) return;
      ready = true;
      resolveReady();
    },
    waitForReady(timeoutMs) {
      if (ready) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        void readyPromise.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    },
  };
}
