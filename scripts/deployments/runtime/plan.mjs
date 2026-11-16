import { rm } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from './artifacts.mjs';
import { sourceCommit } from './exec.mjs';
import { fileExists, readJson } from './fsx.mjs';
import { networkRoot } from './ledger.mjs';

/**
 * A dry run produces a reviewable plan instead of scrollback. The plan is the
 * artifact a reviewer approves: every transaction it intends to send, with
 * decoded calldata, plus the protocol pointers it will move.
 */
export function planFile(context, release) {
  return path.join(networkRoot(context), 'pending', `${release}.plan.json`);
}

export function validationFile(context, release) {
  return path.join(networkRoot(context), 'pending', `${release}.VALIDATION.md`);
}

function describeTransaction(transaction) {
  const call = transaction.transaction ?? {};
  const isCreate = transaction.transactionType === 'CREATE';
  return {
    action: isCreate ? `deploy ${transaction.contractName}` : (transaction.function ?? 'contract call'),
    transactionType: transaction.transactionType ?? null,
    contractName: transaction.contractName ?? null,
    to: isCreate ? null : (call.to ?? null),
    from: call.from ?? null,
    value: call.value ?? '0x0',
    function: transaction.function ?? null,
    arguments: transaction.arguments ?? null,
    calldata: call.input ?? null,
    predictedAddress: isCreate ? (transaction.contractAddress ?? null) : null,
  };
}

function describeOperationalCall(call) {
  return {
    action: call.action,
    transactionType: 'CALL',
    contractName: call.contractName ?? null,
    to: call.to,
    from: call.from ?? null,
    value: call.value ?? '0x0',
    function: call.function,
    arguments: call.arguments ?? [],
    calldata: call.calldata ?? null,
    predictedAddress: null,
    condition: call.condition ?? null,
  };
}

/**
 * Builds the plan from a Foundry simulation file. Simulations have no receipts,
 * so nothing here is presented as confirmed.
 */
export async function buildPlan({
  context,
  release,
  phaseId,
  simulationFile,
  observation,
  pointerChanges,
  beforeTransactions = [],
  afterTransactions = [],
}) {
  const simulation = await fileExists(simulationFile) ? await readJson(simulationFile) : { transactions: [] };
  return {
    migration: context.migrationId,
    release,
    phase: phaseId,
    network: context.network,
    chainId: context.canonical.chainId,
    sourceCommit: sourceCommit(),
    generatedAt: new Date().toISOString(),
    observedState: observation.state,
    simulated: true,
    pointerChanges: pointerChanges ?? {},
    transactions: [
      ...beforeTransactions.map(describeOperationalCall),
      ...(simulation.transactions ?? []).map(describeTransaction),
      ...afterTransactions.map(describeOperationalCall),
    ],
  };
}

function renderPointerTable(pointerChanges) {
  const names = Object.keys(pointerChanges);
  if (names.length === 0) return '_This phase does not move any protocol pointers._\n';
  const rows = names.map((name) => {
    const { before, after } = pointerChanges[name];
    return `| \`${name}\` | \`${before ?? '—'}\` | \`${after ?? '—'}\` |`;
  });
  return ['| Pointer | Before | After |', '| --- | --- | --- |', ...rows].join('\n') + '\n';
}

/** Deploy bytecode is summarized: reviewers verify it through source verification. */
function summarizeBytecode(calldata) {
  const bytes = Math.max(0, (calldata.length - 2) / 2);
  return `${calldata.slice(0, 20)}… (${bytes} bytes)`;
}

function renderTransactions(transactions) {
  if (transactions.length === 0) return '_The simulation produced no transactions._\n';
  return transactions.map((transaction, index) => {
    const lines = [`### ${index + 1}. ${transaction.action}`, ''];
    if (transaction.transactionType === 'CREATE') {
      lines.push(`- Deploys \`${transaction.contractName}\``);
      if (transaction.predictedAddress) lines.push(`- Predicted address: \`${transaction.predictedAddress}\``);
    } else {
      lines.push(`- Target: \`${transaction.to ?? '—'}\`${transaction.contractName ? ` (\`${transaction.contractName}\`)` : ''}`);
      lines.push(`- Function: \`${transaction.function ?? '—'}\``);
      if (transaction.arguments?.length) {
        lines.push('- Arguments:');
        for (const argument of transaction.arguments) lines.push(`  - \`${argument}\``);
      }
    }
    if (transaction.condition) lines.push(`- Condition: ${transaction.condition}`);
    lines.push(`- From: \`${transaction.from ?? '—'}\``);
    lines.push(`- Value: \`${transaction.value}\``);
    // Creation bytecode is long and reviewed via the verified source, not by eye.
    // Call calldata is short and is exactly what a reviewer must check.
    if (transaction.calldata) {
      lines.push(transaction.transactionType === 'CREATE'
        ? `- Creation code: \`${summarizeBytecode(transaction.calldata)}\``
        : `- Calldata: \`${transaction.calldata}\``);
    }
    return lines.join('\n');
  }).join('\n\n') + '\n';
}

/** Renders the human-reviewable companion to the machine-readable plan. */
export function renderValidation(plan) {
  return `# Validation — ${plan.migration} ${plan.phase} (${plan.network})

> Generated by \`pnpm contracts:deploy -- ${plan.migration} --network ${plan.network} --dry-run\`.
> This is a **simulation**. No transaction below has been broadcast.

| Field | Value |
| --- | --- |
| Migration | \`${plan.migration}\` |
| Release | \`${plan.release}\` |
| Phase | \`${plan.phase}\` |
| Network | \`${plan.network}\` (chain \`${plan.chainId}\`) |
| Source commit | \`${plan.sourceCommit}\` |
| Observed state | \`${plan.observedState}\` |
| Generated at | ${plan.generatedAt} |

## Protocol pointer changes

${renderPointerTable(plan.pointerChanges)}
## Transactions (${plan.transactions.length})

${renderTransactions(plan.transactions)}
## Reviewer checklist

- [ ] Every transaction above is expected for this phase.
- [ ] Pointer changes match the reviewed migration intent.
- [ ] Each target address matches the canonical \`current.json\` entry.
- [ ] No unexpected ownership, pause, or minting call is present.
- [ ] The source commit matches the branch under review.
`;
}

export async function writePlan(plan, context, release) {
  await writeJsonAtomic(planFile(context, release), plan);
  await writeFileAtomic(validationFile(context, release), renderValidation(plan));
  return { plan: planFile(context, release), validation: validationFile(context, release) };
}

/**
 * Once a release is on chain its plan is no longer pending: the history record
 * is the authority. Clearing it keeps `pending/` meaning "reviewed but not yet
 * executed" so a stale plan can never be mistaken for the current intent.
 */
export async function clearPlan(context, release) {
  await rm(planFile(context, release), { force: true });
  await rm(validationFile(context, release), { force: true });
}
