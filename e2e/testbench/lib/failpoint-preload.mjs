// Preloaded (NODE_OPTIONS=--import) into a cli-mode node only when the supervisor hands it a fail point file
// (ANTSEED_TESTBENCH_FAILPOINTS_FILE). Installs the handler the payment code's fail points call
// (packages/buyer-core/src/failpoints.ts); nothing in packages/ or apps/ can install one. The spec file is re-read
// when it changes, so a scenario arms a running node; a node from an older tree simply never calls the handler.
import { appendFileSync, readFileSync, statSync, writeSync } from 'node:fs';
import { createFailpointRegistry, FAILPOINT_HANDLER_KEY, FailpointError, FAILPOINTS_FILE_ENV, failpointJournalPath, normalizeFailpointSpec, parseJournal } from './failpoints.mjs';

const RELOAD_EVERY_MS = 200;
const specPath = process.env[FAILPOINTS_FILE_ENV];
// The node itself is the one the supervisor watches and restarts: a helper process it starts gets no handler.
delete process.env[FAILPOINTS_FILE_ENV];

if (specPath) {
  const journalPath = failpointJournalPath(specPath);
  const registry = createFailpointRegistry();
  let stamp = null;
  let checkedAt = -Infinity;

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

  const reload = () => {
    const now = Date.now();
    if (now - checkedAt < RELOAD_EVERY_MS) return;
    checkedAt = now;
    const stat = statSync(specPath, { throwIfNoEntry: false });
    const next = stat ? `${stat.mtimeMs}:${stat.size}:${stat.ino}` : 'none';
    if (next === stamp) return;
    // The counts so far, before the new spec restarts them: a scenario reads how often each point was reached up to now.
    if (stamp !== null) journal({ counts: registry.totals() });
    stamp = next;
    let spec = null;
    try {
      if (stat) spec = normalizeFailpointSpec(JSON.parse(readFileSync(specPath, 'utf8')));
    } catch (error) {
      say(`[Failpoint] spec ignored: ${error.message}`);
    }
    registry.arm(spec, readJournal());
    if (spec && Object.keys(spec.points).length) say(`[Failpoint] armed ${Object.entries(spec.points).map(([point, rule]) => `${point}=${rule.action}${rule.nth ? `@${rule.nth}` : ''}`).join(' ')}`);
  };

  /** Counts the hit and journals it; returns the trigger to act on, or null. */
  const reach = (name, sync) => {
    reload();
    const { hit, first, trigger } = registry.hit(name, { sync });
    if (first) journal({ point: name, reached: true });
    if (!trigger) return null;
    journal({ point: name, hit, action: trigger.action, ...(registry.spec()?.id !== undefined ? { spec: registry.spec().id } : {}), ...(trigger.skipped ? { skipped: trigger.skipped } : {}) });
    say(`[Failpoint] ${name} hit=${hit} action=${trigger.action}${trigger.skipped ? ` (skipped: ${trigger.skipped})` : ''}`);
    if (trigger.skipped) return null;
    if (trigger.action === 'crash') {
      // A real crash: no exit handlers, no settle, no close.
      process.kill(process.pid, 'SIGKILL');
      throw new FailpointError(name);
    }
    if (trigger.action === 'error') throw new FailpointError(name);
    return trigger;
  };

  globalThis[Symbol.for(FAILPOINT_HANDLER_KEY)] = {
    hit(name) {
      const trigger = reach(name, false);
      return trigger?.action === 'delay' ? new Promise((resolve) => setTimeout(resolve, trigger.ms)) : undefined;
    },
    hitSync(name) {
      reach(name, true);
    },
  };

  // How often each point was reached, for a node that stops gracefully: what the catalog's hit counts come from.
  process.on('exit', () => journal({ counts: registry.totals() }));
  // An idle node reaches no point, so it would never notice a new spec: look for one on a timer too.
  setInterval(reload, 1000).unref();
  reload();
}
