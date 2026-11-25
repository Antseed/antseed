/** Runs tasks one at a time, in the order asked. A failed task doesn't stop the next. */
export function createSerialQueue() {
  let last: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const running = last.catch(() => undefined).then(task);
      last = running;
      return running;
    },
    whenSettled(): Promise<void> {
      return last.then(() => undefined, () => undefined);
    },
  };
}
