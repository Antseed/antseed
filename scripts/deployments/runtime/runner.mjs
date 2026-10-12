import { loadDotEnv } from './env.mjs';
import { assertCheckpointBytecode, loadContext, validateArtifacts } from './ledger.mjs';
import { assertCleanForBroadcast, confirmBroadcast } from './preflight.mjs';
import { buildPlan, clearPlan, writePlan } from './plan.mjs';
import { addresses, resolveSigners } from './signers.mjs';
import { runRehearsal } from './rehearsal.mjs';

/**
 * Generic driver shared by every migration.
 *
 * A migration declares WHAT it is (baseline, expected state, phases, how to
 * classify live state) and the runner owns HOW a rollout executes: dotenv
 * loading, observation, guard evaluation, confirmation, clean-tree
 * enforcement, phase dispatch, record writing, and artifact validation.
 */
export async function runMigration(migration, options, overrides = {}) {
  if (options.mode === 'fork-test') {
    const { deploymentMigrations } = await import('../index.mjs');
    return runRehearsal(migration, options, { registry: deploymentMigrations, runMigration });
  }
  await loadDotEnv();
  const context = await loadContext(migration, options.network, overrides);
  return executePhases(migration, options, overrides, context);
}

export async function executePhases(migration, options, overrides, context) {
  let observation = await migration.observe(context);

  if (migration.recover && observation.state === 'invalid') {
    if (await migration.recover(context, observation)) observation = await migration.observe(context);
  }

  migration.printStatus(observation);

  if (observation.state === 'invalid') {
    throw new Error(`${migration.id} live state does not match a safe known state`);
  }

  const phase = selectPhase(migration, observation, options.mode);

  if (!phase) {
    if (migration.finalize) {
      const finalized = await migration.finalize(context, observation, options.mode);
      if (finalized) validateArtifacts(context);
    }
    console.log(migration.idleMessage(observation, options.mode));
    return observation;
  }

  const announcement = phase.announce?.(observation, options.mode);
  if (announcement) console.log(announcement);

  await phase.preflight?.(context, observation);

  // Signers are resolved to addresses here and only ever reach the Solidity
  // scripts as addresses; Foundry pairs them with the wallets in `forgeArgs`.
  const roles = phase.signers(observation, context);
  const specs = { ...options.signers, ...overrides.signers };
  const { signers, forgeArgs } = options.mode === 'broadcast'
    ? await resolveSigners(specs, roles, { rpcUrl: context.rpcUrl })
    : await resolveSigners(dryRunSpecs(specs, roles, migration, context, observation), roles, { rpcUrl: context.rpcUrl });
  const environment = migration.environment(context, observation, addresses(signers), overrides.environment);
  migration.verifyRoles(context, observation, environment);
  const wallet = { signers, forgeArgs };

  if (options.mode === 'broadcast') {
    assertCleanForBroadcast(context, migration.allowedDirtyReleases(observation));
    if (observation.deployment) await assertCheckpointBytecode(context, observation.deployment.checkpoint);
    if (!context.forkTest) await confirmBroadcast(migration.id, options.network);
  }

  const runResult = await phase.run(context, options.mode, environment, observation, wallet);
  const planDescriptor = phase.plan
    ? await phase.plan(context, observation, runResult)
    : null;

  if (options.mode === 'dry-run' && planDescriptor) {
    const plan = await buildPlan({ context, observation, ...planDescriptor });
    const written = await writePlan(plan, context, planDescriptor.release);
    console.log(`Wrote deployment plan: ${written.plan}`);
    console.log(`Wrote review document: ${written.validation}`);
  }

  if (options.mode === 'broadcast') {
    if (planDescriptor) await clearPlan(context, planDescriptor.release);
    validateArtifacts(context);
  }

  return migration.observe(context);
}

/**
 * A dry run needs addresses to simulate as, not wallets. Any role without a
 * signer falls back to the live owner the migration expects, so a review can
 * be generated without touching a keystore or hardware wallet.
 */
function dryRunSpecs(specs, roles, migration, context, observation) {
  const resolved = { ...specs };
  for (const role of roles) {
    if (!resolved[role]) resolved[role] = `unlocked:${migration.expectedSigner(role, context, observation)}`;
  }
  return resolved;
}

/** Picks the first phase whose guard accepts the observed state, if any. */
function selectPhase(migration, observation, mode) {
  return migration.phases.find((phase) => phase.guard(observation, mode)) ?? null;
}
