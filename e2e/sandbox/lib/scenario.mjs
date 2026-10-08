import { percentile } from './metrics.mjs';

/**
 * Declarative scenarios: topology + workload + phases (faults and expectations per phase) + run-wide
 * expectations. One open-loop workload runs across all phases; faults fire at phase offsets; each phase's
 * expectations are evaluated over the requests that started inside it. Global invariants run after every
 * scenario anyway (see runner), so a scenario only states what is specific to it.
 *
 *   export default {
 *     meta: { description, requires },
 *     topology: { sellers, routers },
 *     workload: { spec: 'chat-only', via: 'router:levanto', rateMultiplier: 1 },
 *     phases: [
 *       { name: 'baseline', duration: '20s', expect: { successRate: '>=0.99' } },
 *       { name: 'outage', duration: '20s', faults: [{ stop: 'fast' }], expect: { 'servedBy.fast': '==0' } },
 *       { name: 'recover', duration: '30s', faults: [{ start: 'fast' }], expect: { 'recoveryMs.fast': '<20000' } },
 *     ],
 *     expect: { successRate: '>=0.9' },
 *   };
 */

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m)$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const OPS = ['>=', '<=', '==', '!=', '>', '<'];
const FAULT_KINDS = ['stop', 'start', 'mock', 'warp', 'closeChannel'];
const SCENARIO_KEYS = new Set(['meta', 'topology', 'workload', 'phases', 'expect', 'setup', 'run']);
const PHASE_KEYS = new Set(['name', 'duration', 'faults', 'expect', 'known']);
const WORKLOAD_KEYS = new Set(['spec', 'via', 'models', 'rateMultiplier', 'maxInFlight']);

/** '30s' | '2m' | '500ms' | number (ms) -> ms. */
export function parseDuration(value, label) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
  const match = typeof value === 'string' ? DURATION.exec(value.trim()) : null;
  if (!match) throw new Error(`${label} must be a duration like 500ms, 30s or 2m (got ${JSON.stringify(value)})`);
  const amount = Number(match[1]);
  return Math.round(match[2] === 'ms' ? amount : match[2] === 's' ? amount * 1000 : amount * 60_000);
}

/** '>=0.99' | '<2000' | '==0' | number (equality) -> { op, value }. */
export function parseExpectation(raw, label) {
  if (typeof raw === 'number') return { op: '==', value: raw };
  if (typeof raw === 'boolean') return { op: '==', value: raw };
  const text = typeof raw === 'string' ? raw.trim() : '';
  const op = OPS.find((candidate) => text.startsWith(candidate));
  const value = op ? Number(text.slice(op.length).trim()) : NaN;
  if (!op || !Number.isFinite(value)) throw new Error(`${label} must look like ">=0.99", "<2000" or "==0" (got ${JSON.stringify(raw)})`);
  return { op, value };
}

function compare(actual, { op, value }) {
  if (typeof value === 'boolean') return actual === value;
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
  switch (op) {
    case '>=': return actual >= value;
    case '<=': return actual <= value;
    case '>': return actual > value;
    case '<': return actual < value;
    case '==': return actual === value;
    default: return actual !== value;
  }
}

function normalizeExpect(expect, label) {
  if (expect === undefined) return {};
  if (!expect || typeof expect !== 'object' || Array.isArray(expect)) throw new Error(`${label} must be an object of metric: "op value"`);
  return Object.fromEntries(Object.entries(expect).map(([key, raw]) => {
    if (!/^[A-Za-z][A-Za-z0-9]*(\.[a-z0-9-]+)?$/.test(key)) throw new Error(`${label} has an invalid metric name "${key}"`);
    return [key, { raw, ...parseExpectation(raw, `${label}.${key}`) }];
  }));
}

/** Validates one fault: exactly one of stop/start/mock/warp/closeChannel, plus an optional `at` offset in the phase. */
export function normalizeFault(fault, label) {
  if (!fault || typeof fault !== 'object' || Array.isArray(fault)) throw new Error(`${label} must be an object`);
  const kinds = FAULT_KINDS.filter((kind) => fault[kind] !== undefined);
  if (kinds.length !== 1) throw new Error(`${label} needs exactly one of ${FAULT_KINDS.join(', ')}`);
  const [kind] = kinds;
  for (const key of Object.keys(fault)) if (key !== kind && key !== 'at' && key !== 'restore') throw new Error(`${label} has unknown key "${key}"`);
  const atMs = fault.at === undefined ? 0 : parseDuration(fault.at, `${label}.at`);
  const out = { kind, atMs };
  if (kind === 'stop' || kind === 'start' || kind === 'closeChannel') {
    if (!NAME.test(String(fault[kind]))) throw new Error(`${label}.${kind} must be a seller id`);
    out.target = fault[kind];
  } else if (kind === 'warp') {
    out.seconds = Math.round(parseDuration(fault.warp, `${label}.warp`) / 1000);
    if (out.seconds < 1) throw new Error(`${label}.warp must be at least 1s`);
  } else {
    const mock = fault.mock;
    if (!mock || typeof mock !== 'object' || !NAME.test(String(mock.seller)) || !mock.patch || typeof mock.patch !== 'object') {
      throw new Error(`${label}.mock must be { seller, patch }`);
    }
    out.target = mock.seller;
    out.patch = mock.patch;
    out.restore = fault.restore !== false;
  }
  return out;
}

/**
 * Validates the declarative parts of a scenario module and returns a normalized plan, or null when the
 * module only has a run(sb) function. Seller ids in faults and expectations are checked against the topology.
 */
export function normalizeDeclarative(mod, name) {
  if (mod.phases === undefined && mod.workload === undefined && mod.expect === undefined) return null;
  for (const key of Object.keys(mod)) if (!SCENARIO_KEYS.has(key)) throw new Error(`Scenario ${name}: unknown key "${key}"`);
  if (!Array.isArray(mod.phases) || mod.phases.length === 0) throw new Error(`Scenario ${name}: phases must list at least one phase`);
  const sellerIds = new Set((mod.topology?.sellers ?? []).map((seller, index) => seller.id ?? `seller-${index + 1}`));
  const routerIds = new Set((mod.topology?.routers ?? []).map((router, index) => router.id ?? `router-${index + 1}`));
  const workloadIn = mod.workload ?? {};
  for (const key of Object.keys(workloadIn)) if (!WORKLOAD_KEYS.has(key)) throw new Error(`Scenario ${name}: unknown workload key "${key}"`);
  let via = null;
  if (workloadIn.via !== undefined) {
    const match = /^router:([a-z0-9][a-z0-9-]{0,23})$/.exec(String(workloadIn.via));
    if (!match || !routerIds.has(match[1])) throw new Error(`Scenario ${name}: workload.via must be router:<id> of a topology router`);
    via = { router: match[1] };
  }
  const workload = {
    spec: workloadIn.spec ?? 'chat-only',
    via,
    models: workloadIn.models,
    rateMultiplier: workloadIn.rateMultiplier ?? 1,
    maxInFlight: workloadIn.maxInFlight,
  };
  if (!(typeof workload.rateMultiplier === 'number' && workload.rateMultiplier > 0 && workload.rateMultiplier <= 10_000)) throw new Error(`Scenario ${name}: workload.rateMultiplier must be in (0, 10000]`);
  const names = new Set();
  let startMs = 0;
  const phases = mod.phases.map((phase, index) => {
    const label = `Scenario ${name} phases[${index}]`;
    if (!phase || typeof phase !== 'object') throw new Error(`${label} must be an object`);
    for (const key of Object.keys(phase)) if (!PHASE_KEYS.has(key)) throw new Error(`${label}: unknown key "${key}"`);
    const phaseName = phase.name ?? `phase-${index + 1}`;
    if (!NAME.test(phaseName) || names.has(phaseName)) throw new Error(`${label}: name must be unique and match ${NAME}`);
    names.add(phaseName);
    const durationMs = parseDuration(phase.duration, `${label}.duration`);
    if (durationMs < 1000) throw new Error(`${label}.duration must be at least 1s`);
    const faults = (phase.faults ?? []).map((fault, faultIndex) => normalizeFault(fault, `${label}.faults[${faultIndex}]`));
    for (const fault of faults) {
      if (fault.target && !sellerIds.has(fault.target)) throw new Error(`${label}: unknown seller "${fault.target}" in a ${fault.kind} fault`);
      if (fault.atMs >= durationMs) throw new Error(`${label}: fault at ${fault.atMs}ms is outside the ${durationMs}ms phase`);
    }
    const expect = normalizeExpect(phase.expect, `${label}.expect`);
    checkExpectTargets(expect, sellerIds, label);
    const known = normalizeKnown(phase.known, `${label}.known`);
    checkExpectTargets(known, sellerIds, label);
    const normalized = { name: phaseName, startMs, durationMs, endMs: startMs + durationMs, faults, expect, known };
    startMs += durationMs;
    return normalized;
  });
  const expect = normalizeExpect(mod.expect, `Scenario ${name} expect`);
  checkExpectTargets(expect, sellerIds, `Scenario ${name} expect`);
  if (mod.setup !== undefined && typeof mod.setup !== 'function') throw new Error(`Scenario ${name}: setup must be a function`);
  return { workload, phases, durationMs: startMs, expect, setup: mod.setup ?? null };
}

/** Known issues: { metric: { expect: '<45000', issue: 'tracked defect' } }; recorded, fail only under --strict. */
function normalizeKnown(known, label) {
  if (known === undefined) return {};
  if (!known || typeof known !== 'object' || Array.isArray(known)) throw new Error(`${label} must be an object of metric: { expect, issue }`);
  const out = {};
  for (const [key, entry] of Object.entries(known)) {
    if (!entry || typeof entry !== 'object' || typeof entry.issue !== 'string' || !entry.issue.trim()) throw new Error(`${label}.${key} must be { expect, issue }`);
    out[key] = { ...normalizeExpect({ [key]: entry.expect }, label)[key], issue: entry.issue.trim() };
  }
  return out;
}

const PER_SELLER = new Set(['servedBy', 'share', 'recoveryMs', 'failedOn']);
function checkExpectTargets(expect, sellerIds, label) {
  for (const key of Object.keys(expect)) {
    const [metric, target] = key.split('.');
    if (target === undefined) { if (PER_SELLER.has(metric)) throw new Error(`${label}: ${metric} needs a seller, e.g. ${metric}.<id>`); continue; }
    if (!PER_SELLER.has(metric)) throw new Error(`${label}: ${metric} is not a per-seller metric`);
    if (!sellerIds.has(target)) throw new Error(`${label}: unknown seller "${target}" in ${key}`);
  }
}

/**
 * Flat metrics for the requests that started in [fromMs, toMs). `anchorMs` is where recovery is measured
 * from (end of the phase's faults): recoveryMs.<id> is the time from it to the first success on that seller.
 */
export function windowMetrics(records, { sellers, models = [], fromMs = 0, toMs = Infinity, anchorMs = fromMs }) {
  const slice = records.filter((record) => record.startMs >= fromMs && record.startMs < toMs);
  const ok = slice.filter((record) => record.ok);
  const rounded = (value) => (value === null ? null : Math.round(value));
  const out = {
    requests: slice.length,
    succeeded: ok.length,
    failed: slice.length - ok.length,
    successRate: slice.length ? ok.length / slice.length : null,
    errorRate: slice.length ? (slice.length - ok.length) / slice.length : null,
    ttftP50Ms: rounded(percentile(ok.filter((record) => record.stream).map((record) => record.ttftMs), 50)),
    ttftP95Ms: rounded(percentile(ok.filter((record) => record.stream).map((record) => record.ttftMs), 95)),
    latencyP50Ms: rounded(percentile(ok.map((record) => record.latencyMs), 50)),
    latencyP95Ms: rounded(percentile(ok.map((record) => record.latencyMs), 95)),
    latencyP99Ms: rounded(percentile(ok.map((record) => record.latencyMs), 99)),
    distinctSellers: new Set(ok.map((record) => record.sellerId).filter(Boolean)).size,
    distinctModels: new Set(ok.map((record) => record.servedModel ?? record.model).filter(Boolean)).size,
  };
  for (const id of sellers) {
    const served = ok.filter((record) => record.sellerId === id);
    out[`servedBy.${id}`] = served.length;
    out[`share.${id}`] = ok.length ? served.length / ok.length : null;
    out[`failedOn.${id}`] = slice.filter((record) => !record.ok && record.sellerId === id).length;
    const first = served.filter((record) => record.startMs >= anchorMs).sort((a, b) => a.startMs - b.startMs)[0];
    out[`recoveryMs.${id}`] = first ? Math.round(first.startMs - anchorMs) : null;
  }
  void models;
  return out;
}

/** Time each phase's first fault actually started (from workload timeline events), by phase name. */
function firstFaultAt(events, phases) {
  const out = new Map();
  for (const event of events) {
    if (event.name.endsWith(':restore')) continue;
    const name = event.name.split(':')[0];
    if (phases.some((phase) => phase.name === name)) out.set(name, Math.min(out.get(name) ?? Infinity, event.startMs));
  }
  return out;
}

/**
 * Records by phase: a request belongs to the phase it started in, unless it failed after the next phase's
 * first fault fired; then the fault caused the failure and it counts in that next phase.
 */
export function assignPhases(records, phases, faultStarts = new Map()) {
  const out = new Map(phases.map((phase) => [phase.name, []]));
  for (const record of records) {
    let index = phases.findIndex((phase) => record.startMs >= phase.startMs && record.startMs < phase.endMs);
    if (index === -1) index = phases.length - 1;
    const next = phases[index + 1];
    const fault = next ? faultStarts.get(next.name) : undefined;
    if (fault !== undefined && !record.ok && record.startMs + (record.latencyMs ?? 0) > fault) index += 1;
    out.get(phases[index].name).push(record);
  }
  return out;
}

/** Evaluates normalized expectations against window metrics; never throws. */
export function evaluateExpectations(expect, metrics, scope) {
  return Object.entries(expect).map(([key, expectation]) => {
    const actual = metrics[key];
    return {
      name: `${scope}: ${key} ${typeof expectation.raw === 'string' ? expectation.raw : `== ${expectation.raw}`}`,
      ok: compare(actual, expectation),
      detail: { actual: actual ?? null, expected: expectation.raw },
    };
  });
}

/** Runs a fault through the scenario API; returns an undo action for restorable faults. */
async function applyFault(sb, fault) {
  switch (fault.kind) {
    case 'stop': await sb.stopSeller(fault.target); return null;
    case 'start': await sb.startSeller(fault.target); return null;
    case 'warp': await sb.warp(fault.seconds); return null;
    case 'closeChannel': await sb.closeChannel(fault.target); return null;
    default: {
      const before = fault.restore ? await sb.mockProfileRaw(fault.target) : null;
      await sb.setMockProfile(fault.target, fault.patch);
      return before ? () => sb.setMockProfile(fault.target, before, { replace: true }) : null;
    }
  }
}

/** Runs a normalized declarative scenario: setup, one workload across all phases with timed faults, then expectations. */
export async function runDeclarative(sb, plan) {
  let models = plan.workload.models;
  if (plan.workload.via) {
    await sb.useRouter(plan.workload.via.router);
    models = models ?? ['antseed'];
  }
  if (plan.setup) await plan.setup(sb);
  const undo = [];
  const faultEnds = new Map();
  const timeline = [];
  for (const phase of plan.phases) {
    faultEnds.set(phase.name, phase.startMs);
    phase.faults.forEach((fault, index) => {
      timeline.push({
        atMs: phase.startMs + fault.atMs,
        name: `${phase.name}:${fault.kind}${fault.target ? `:${fault.target}` : ''}#${index}`,
        action: async () => {
          const restore = await applyFault(sb, fault);
          if (restore) undo.push({ phase: phase.name, restore });
          return { kind: fault.kind, target: fault.target ?? null };
        },
      });
    });
    // Restorable faults (mock patches) end with their phase.
    if (phase.faults.some((fault) => fault.kind === 'mock' && fault.restore)) {
      timeline.push({
        atMs: phase.endMs - 1,
        name: `${phase.name}:restore`,
        action: async () => {
          for (const entry of undo.filter((item) => item.phase === phase.name).reverse()) await entry.restore();
          return { restored: undo.filter((item) => item.phase === phase.name).length };
        },
      });
    }
  }
  const result = await sb.runWorkload({
    workload: plan.workload.spec,
    durationMs: plan.durationMs,
    rateMultiplier: plan.workload.rateMultiplier,
    ...(models ? { models } : {}),
    ...(plan.workload.maxInFlight ? { maxInFlight: plan.workload.maxInFlight } : {}),
    timeline,
    label: 'scenario',
  });
  for (const event of result.events) {
    if (!event.ok) sb.expect(`fault ${event.name} applied`, false, { error: event.error });
    const phaseName = event.name.split(':')[0];
    if (!event.name.endsWith(':restore')) faultEnds.set(phaseName, Math.max(faultEnds.get(phaseName) ?? 0, event.endMs ?? 0));
  }
  const sellers = sb.sellers.map((seller) => seller.id);
  const byPhase = assignPhases(result.records, plan.phases, firstFaultAt(result.events, plan.phases));
  const phaseMetrics = {};
  for (const phase of plan.phases) {
    const metrics = windowMetrics(byPhase.get(phase.name), { sellers, anchorMs: faultEnds.get(phase.name) });
    phaseMetrics[phase.name] = metrics;
    for (const entry of evaluateExpectations(phase.expect, metrics, `phase ${phase.name}`)) sb.expect(entry.name, entry.ok, entry.detail);
    for (const [key, known] of Object.entries(phase.known)) {
      const [entry] = evaluateExpectations({ [key]: known }, metrics, `phase ${phase.name}`);
      sb.knownIssue(entry.name, entry.ok, entry.detail, known.issue);
    }
  }
  const overall = windowMetrics(result.records, { sellers });
  for (const entry of evaluateExpectations(plan.expect, overall, 'run')) sb.expect(entry.name, entry.ok, entry.detail);
  sb.metric('phases', phaseMetrics);
  sb.metric('run', overall);
  sb.metric('faults', result.events.map(({ name, scheduledMs, startMs, endMs, ok, error }) => ({ name, scheduledMs: Math.round(scheduledMs), startMs: Math.round(startMs), endMs: Math.round(endMs ?? startMs), ok, ...(error ? { error } : {}) })));
  return { result, phaseMetrics, overall };
}
