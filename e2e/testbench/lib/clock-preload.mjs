// Preloaded into a one-shot CLI command run with tb.cli({ clock: 'chain' }) (NODE_OPTIONS=--import): shifts the
// process clock by ANTSEED_TESTBENCH_CLOCK_OFFSET_MS so the command reads the testbench chain's time. A scenario that
// warps the chain (tb.warp) uses it for commands that compare chain timestamps with Date.now(), as a real user would
// run them once that much wall time had passed.
const offset = Number(process.env.ANTSEED_TESTBENCH_CLOCK_OFFSET_MS ?? 0);
if (!Number.isFinite(offset)) throw new Error('ANTSEED_TESTBENCH_CLOCK_OFFSET_MS must be a number of milliseconds');
if (offset !== 0) {
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }

    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate;
}
