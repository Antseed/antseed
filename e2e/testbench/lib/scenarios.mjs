import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCENARIOS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');

/**
 * Every scenario file, one folder per group: `scenarios/features/`, `stress/`, `issues/`, `mainnet/`. A scenario is run
 * by its bare name, so names must be unique across groups. Returns `[{ name, group, file }]` sorted by name; `group` is
 * null for a file directly in `scenarios/`, which a test rejects.
 */
export function scenarioFiles(dir = SCENARIOS_DIR) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) {
      found.push({ name: entry.name.slice(0, -4), group: null, file: join(dir, entry.name) });
    } else if (entry.isDirectory()) {
      for (const file of readdirSync(join(dir, entry.name))) {
        if (file.endsWith('.mjs')) found.push({ name: file.slice(0, -4), group: entry.name, file: join(dir, entry.name, file) });
      }
    }
  }
  const byName = new Map();
  for (const scenario of found) {
    const other = byName.get(scenario.name);
    if (other) throw new Error(`Scenario name ${scenario.name} is used twice (${other.file} and ${scenario.file}); names must be unique across groups`);
    byName.set(scenario.name, scenario);
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** The file for a scenario name, wherever its group puts it, or null. */
export function scenarioFile(name, dir = SCENARIOS_DIR) {
  return scenarioFiles(dir).find((scenario) => scenario.name === name)?.file ?? null;
}

/**
 * What a scenario arms at fail points for a run seed, as JSON text: its `failpointPlan(seed)` (the drawn plan and
 * every spec, seeds included). It needs no testbench, and two prints of one seed are identical, so they can be diffed.
 * What a run then does with the plan is not replayed: the nodes are real processes on a real clock.
 */
export function failpointPlanText(scenario, seed) {
  if (typeof scenario.failpointPlan !== 'function') throw new Error(`Scenario ${scenario.name} arms no seeded fail point plan (it exports no failpointPlan)`);
  return JSON.stringify({ scenario: scenario.name, seed, ...scenario.failpointPlan(seed) }, null, 2);
}
