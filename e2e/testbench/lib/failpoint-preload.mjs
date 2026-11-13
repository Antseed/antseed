// Preloaded (NODE_OPTIONS=--import) into a cli-mode node only when the supervisor hands it a fail point file
// (ANTSEED_TESTBENCH_FAILPOINTS_FILE). Installs the handler the payment code's fail points call
// (packages/buyer-core/src/failpoints.ts); nothing in packages/ or apps/ can install one. The spec file is re-read
// when it changes, so a scenario arms a running node; a node from an older tree simply never calls the handler.
import { appendFileSync, readFileSync, statSync, writeSync } from 'node:fs';
import { crashBlocked, createFailpointRegistry, FAILPOINT_HANDLER_KEY, FailpointError, FAILPOINTS_FILE_ENV, failpointJournalPath, failpointSharedStatePath, normalizeFailpointSpec, parseJournal } from './failpoints.mjs';

const RELOAD_EVERY_MS = 200;
const SHARED_MAX_AGE_MS = 50;
const KILL_POLL_MS = 25;
const specPath = process.env[FAILPOINTS_FILE_ENV];
// The node itself is the one the supervisor watches and restarts: a helper process it starts gets no handler.
delete process.env[FAILPOINTS_FILE_ENV];

if (specPath) {
  const journalPath = failpointJournalPath(specPath);
  const registry = createFailpointRegistry();
  const sharedPath = failpointSharedStatePath(specPath);
  let stamp = null;
  let checkedAt = -Infinity;
  let shared = null;
  let sharedReadAt = -Infinity;
  let dying = false;

  /**
   * The supervisor's shared crash state, asked only when a crash rule would trigger: is another node down, or a grace
   * window running. Re-read at most every 50 ms, so a rule that asks on every hit (whenDown) costs one small read.
   */
  const others = () => {
    const now = Date.now();
    if (now - sharedReadAt >= SHARED_MAX_AGE_MS) {
      sharedReadAt = now;
      try { shared = JSON.parse(readFileSync(sharedPath, 'utf8')); } catch { shared = null; }
    }
    return crashBlocked(shared, now);
  };

  /** Durable before anything else happens: the supervisor reads this to tell a fail point crash from a real one. */
  const journal = (entry) => {
    try { appendFileSync(journalPath, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`); } catch { /* evidence only */ }
  };
  const readJournal = () => {
    try { return parseJournal(readFileSync(journalPath, 'utf8')); } catch { return []; }
  };
  /** Straight to fd 2, so the line is in the node log even when the next statement kills the process. */
  const say = (line) => {
    try { writeSync(2, `${line}\n`); } catch { /* a full pipe must not change what the point does */ }
  };

  /** The delays that waited under the spec armed now, for the entry that ends this arming in this process; nothing when none did. */
  const delayTotals = () => {
    const delays = registry.delays();
    return Object.keys(delays).length ? { delays, ...(registry.spec()?.id !== undefined ? { spec: registry.spec().id } : {}) } : {};
  };
  const ruleLabel = (rule) => `${rule.action}${rule.nth ? `@${rule.nth}` : ''}${rule.p !== undefined ? `~${Number(rule.p.toPrecision(3))}` : ''}${rule.keyed ? '(keyed)' : ''}${rule.killWhenDown ? `(kill once ${rule.killWhenDown} is down)` : ''}${rule.whenDown ? `(when ${rule.whenDown} is down)` : ''}`;

  const reload = () => {
    const now = Date.now();
    if (now - checkedAt < RELOAD_EVERY_MS) return;
    checkedAt = now;
    const stat = statSync(specPath, { throwIfNoEntry: false });
    const next = stat ? `${stat.mtimeMs}:${stat.size}:${stat.ino}` : 'none';
    if (next === stamp) return;
    // The counts so far, before the new spec restarts them: a scenario reads how often each point was reached up to now.
    if (stamp !== null) journal({ counts: registry.totals(), ...delayTotals() });
    stamp = next;
    let spec = null;
    try {
      if (stat) spec = normalizeFailpointSpec(JSON.parse(readFileSync(specPath, 'utf8')));
    } catch (error) {
      say(`[Failpoint] spec ignored: ${error.message}`);
    }
    registry.arm(spec, readJournal());
    if (spec && Object.keys(spec.points).length) say(`[Failpoint] armed ${Object.entries(spec.points).map(([point, rule]) => `${point}=${[rule].flat().map(ruleLabel).join('+')}`).join(' ')}`);
  };

  /** Counts the hit and journals it; returns the trigger to act on, or null. */
  const reach = (name, sync, key) => {
    if (dying) return null;
    reload();
    const { hit, first, trigger } = registry.hit(name, { sync, others, ...(typeof key === 'string' ? { key } : {}) });
    if (first) journal({ point: name, reached: true });
    if (!trigger) return null;
    // Only the first delay of a point is a line of its own: the rest are counted in the `delays` entry of this arming.
    const entry = {
      point: name, hit, action: trigger.action,
      ...(trigger.ms !== undefined ? { ms: trigger.ms } : {}),
      ...(trigger.rule !== undefined ? { rule: trigger.rule } : {}),
      ...(trigger.key !== undefined ? { key: trigger.key } : {}),
      ...(registry.spec()?.id !== undefined ? { spec: registry.spec().id } : {}),
      ...(trigger.skipped ? { skipped: trigger.skipped } : {}),
    };
    // A crash that comes after its point is journaled when it kills, so the line's time is the time of death.
    const later = trigger.action === 'crash' && !trigger.skipped && (trigger.killAfterMs || trigger.killWhenDown);
    if (!trigger.quiet && !later) journal(entry);
    say(`[Failpoint] ${name} hit=${hit} action=${trigger.action}${trigger.key !== undefined ? ` key=${trigger.key}` : ''}${trigger.skipped ? ` (skipped: ${trigger.skipped})` : ''}${trigger.killAfterMs ? ` (kill in ${trigger.killAfterMs} ms)` : ''}${trigger.killWhenDown ? ` (kill once ${trigger.killWhenDown} is down)` : ''}`);
    if (trigger.skipped) return null;
    if (trigger.action === 'crash') {
      const die = () => {
        if (later) journal({ ...entry, triggeredAt });
        // The delays of this life would die with it.
        const delays = delayTotals();
        if (delays.delays) journal(delays);
        // A real crash: no exit handlers, no settle, no close.
        process.kill(process.pid, 'SIGKILL');
      };
      const triggeredAt = new Date().toISOString();
      // A crash that comes after its point: the node runs on, and nothing else fires in a process that is about to
      // die. Either after a set time (a frame it just handed to its connection leaves), or once the shared state
      // says another node is down (that node dies at the same payment step, when it gets there).
      if (later) {
        dying = true;
        if (trigger.killWhenDown) {
          const timer = setInterval(() => { sharedReadAt = -Infinity; if (others().down.includes(trigger.killWhenDown)) { clearInterval(timer); die(); } }, KILL_POLL_MS);
        } else setTimeout(die, trigger.killAfterMs);
        return null;
      }
      die();
      throw new FailpointError(name);
    }
    if (trigger.action === 'error') throw new FailpointError(name);
    return trigger;
  };

  globalThis[Symbol.for(FAILPOINT_HANDLER_KEY)] = {
    hit(name, key) {
      const trigger = reach(name, false, key);
      return trigger?.action === 'delay' ? new Promise((resolve) => setTimeout(resolve, trigger.ms)) : undefined;
    },
    hitSync(name, key) {
      reach(name, true, key);
    },
  };

  // How often each point was reached, for a node that stops gracefully: what the catalog's hit counts come from.
  process.on('exit', () => journal({ counts: registry.totals(), ...delayTotals() }));
  // An idle node reaches no point, so it would never notice a new spec: look for one on a timer too.
  setInterval(reload, 1000).unref();
  reload();
}
