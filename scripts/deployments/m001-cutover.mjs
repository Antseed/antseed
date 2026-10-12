import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withAnvilFork } from './runtime/anvil.mjs';
import { call, cast, numberValue, sameAddress } from './runtime/chain.mjs';
import { runForgeScript, simulationPath } from './runtime/foundry.mjs';

/**
 * M001's epoch-boundary cutover: pause settlements, wait for the boundary, flip
 * the registry pointers, verify the end state, and only then unpause.
 *
 * The safety property is simple: Channels is unpaused only when this process
 * took (or provably adopted) the pause AND both registry pointers are verified
 * on chain. Any other outcome leaves Channels paused for a human.
 */

const CUTOVER_SCRIPT = 'script/migrations/M001RecognizedUsage/Cutover.s.sol:M001CutoverRecognizedUsage';
export const PAUSE_LEAD_SECONDS = 60;

export function cutoverSchedule({ genesis, epochDuration, effectiveEpoch }) {
  const target = genesis + effectiveEpoch * epochDuration;
  return { target, pauseAt: target - PAUSE_LEAD_SECONDS };
}

/**
 * `adopt` resumes a pause this migration previously took and can prove;
 * `foreign` means somebody else paused the contract, so we must not unpause it.
 */
export function pauseDecision({ simulation, isPaused, canAdopt }) {
  if (simulation) return 'skip-simulation';
  if (!isPaused) return 'pause';
  return canAdopt ? 'adopt' : 'foreign';
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntil(timestamp, now = () => Math.floor(Date.now() / 1000)) {
  while (now() < timestamp) {
    const remaining = timestamp - now();
    await sleep(Math.min(remaining + 1, 300) * 1000);
  }
}

/** `wallet` is the cast wallet selection for the signer (e.g. `--keystore <file>`); no key is handled here. */
async function sendAndRecord({ rpcUrl, contract, signature, wallet, receiptFile }) {
  const output = cast(rpcUrl, ['send', contract, signature, ...wallet, '--json']);
  if (receiptFile) {
    await mkdir(path.dirname(receiptFile), { recursive: true });
    await writeFile(receiptFile, output);
  }
}

function recoveryInstructions({ channels, rpcUrl }) {
  return [
    '',
    '!! AntseedChannels REMAINS PAUSED: the cutover did not reach its verified end state.',
    '!! Fix the failure and rerun the migration - the phase is idempotent and',
    '!! finishes whatever is left.',
    '!! To recover manually instead:',
    `!!   cast send ${channels} 'unpause()' --account <channels-owner keystore> --rpc-url ${rpcUrl}`,
  ].join('\n');
}

export function verifyPointers({ emissions, staking, expectedEmissions, expectedStaking }) {
  const errors = [];
  if (!sameAddress(emissions, expectedEmissions)) {
    errors.push(`registry.emissions() is ${emissions}, expected ${expectedEmissions}`);
  }
  if (!sameAddress(staking, expectedStaking)) {
    errors.push(`registry.staking() is ${staking}, expected ${expectedStaking}`);
  }
  return errors;
}

function operationalTransactions({ channels, pauseOwner, pauseAt }) {
  return {
    beforeTransactions: [{
      action: 'pause AntseedChannels',
      contractName: 'AntseedChannels',
      to: channels,
      from: pauseOwner,
      function: 'pause()',
      calldata: '0x8456cb59',
      condition: `Broadcast at unix ${pauseAt}, unless Channels is already paused`,
    }],
    afterTransactions: [{
      action: 'unpause AntseedChannels',
      contractName: 'AntseedChannels',
      to: channels,
      from: pauseOwner,
      function: 'unpause()',
      calldata: '0x3f4ba83a',
      condition: 'Broadcast only when M001 owns the pause and both registry pointers are verified',
    }],
  };
}

async function runCutoverOnRpc(options, deps, schedule) {
  const {
    rpcUrl, registry, usageAccounting, sellerRegistry, receiptDirectory,
    simulation, canAdoptPause, pauseWallet, pauseOwner, environment, etherscanApiKey, forkTest, walletArgs,
  } = options;
  const { target, pauseAt, effectiveEpoch } = schedule;
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const wait = deps.waitUntil ?? waitUntil;
  const send = deps.send ?? sendAndRecord;
  const forge = deps.runScript ?? runForgeScript;
  const read = deps.read ?? ((address, signature) => call(rpcUrl, address, signature));
  const pollSeconds = options.pollSeconds ?? 30;
  const channels = read(registry, 'channels()(address)');

  let currentEpoch = numberValue(read(schedule.gate, 'currentEpoch()(uint256)'));
  if (!simulation && currentEpoch < effectiveEpoch && now() < pauseAt) {
    log(`waiting ${pauseAt - now()}s until channels pause (boundary - ${PAUSE_LEAD_SECONDS}s)...`);
    await wait(pauseAt, now);
  }

  const decision = pauseDecision({
    simulation,
    isPaused: read(channels, 'paused()(bool)') === 'true',
    canAdopt: canAdoptPause,
  });
  if (decision === 'pause') {
    log('pausing channels...');
    await send({
      rpcUrl, contract: channels, signature: 'pause()', wallet: pauseWallet,
      receiptFile: receiptDirectory ? path.join(receiptDirectory, 'pause.json') : null,
    });
    log('channels paused');
  } else if (decision === 'adopt') {
    log('channels already paused; adopting pause for verified M001 resume');
  } else if (decision === 'foreign') {
    log('channels already paused (not by us - will not unpause)');
  } else {
    log('DRY_RUN: recording the Channels pause without sending it');
  }

  let pauseOwned = decision === 'pause' || decision === 'adopt';
  let endStateVerified = false;

  try {
    if (!simulation) {
      if (currentEpoch < effectiveEpoch && now() < target) {
        log('waiting for the epoch boundary...');
        await wait(target, now);
      }
      for (;;) {
        currentEpoch = numberValue(read(schedule.gate, 'currentEpoch()(uint256)'));
        if (currentEpoch >= effectiveEpoch) break;
        log(`current epoch ${currentEpoch} < ${effectiveEpoch}, polling again in ${pollSeconds}s...`);
        await sleep(pollSeconds * 1000);
      }
      log(`epoch ${effectiveEpoch} started — running the cutover flip`);
    }

    forge({
      target: CUTOVER_SCRIPT,
      rpcUrl,
      broadcast: !simulation,
      verify: !forkTest,
      etherscanApiKey,
      env: environment,
      walletArgs,
      slow: forkTest,
    });

    if (simulation) {
      log('DRY_RUN complete on a disposable fork; live pointers remain unchanged');
      return {
        endStateVerified: false,
        pauseOwned,
        channels,
        simulationFile: simulationPath('Cutover.s.sol', options.chainId),
        ...operationalTransactions({ channels, pauseOwner, pauseAt }),
      };
    }

    log('verifying registry pointers...');
    const errors = verifyPointers({
      emissions: read(registry, 'emissions()(address)'),
      staking: read(registry, 'staking()(address)'),
      expectedEmissions: usageAccounting,
      expectedStaking: sellerRegistry,
    });
    if (errors.length) throw new Error(`Cutover verification FAILED: ${errors.join('; ')}`);
    log('registry pointers verified: emissions and staking are on the new stack');
    endStateVerified = true;

    if (pauseOwned && endStateVerified) {
      log('unpausing channels...');
      await send({
        rpcUrl, contract: channels, signature: 'unpause()', wallet: pauseWallet,
        receiptFile: receiptDirectory ? path.join(receiptDirectory, 'unpause.json') : null,
      });
      pauseOwned = false;
      log('channels unpaused');
    }
    log('flip complete');
    return { endStateVerified, pauseOwned, channels };
  } finally {
    if (pauseOwned && !endStateVerified) {
      console.error(recoveryInstructions({ channels, rpcUrl }));
    }
  }
}

/** Runs M001 against live RPC for broadcasts and a disposable fork for reviews. */
export async function runCutover(options, deps = {}) {
  const read = deps.read ?? ((address, signature) => call(options.rpcUrl, address, signature));
  const gate = read(options.usageAccounting, 'emissionsGate()(address)');
  const genesis = numberValue(read(gate, 'genesis()(uint256)'));
  const epochDuration = numberValue(read(gate, 'epochDuration()(uint256)'));
  const effectiveEpoch = numberValue(read(gate, 'effectiveEpoch()(uint256)'));
  const currentEpoch = numberValue(read(gate, 'currentEpoch()(uint256)'));
  const schedule = { gate, effectiveEpoch, ...cutoverSchedule({ genesis, epochDuration, effectiveEpoch }) };
  const log = deps.log ?? console.log;

  log(`gate:            ${gate}`);
  log(`effective epoch: ${effectiveEpoch} (starts at unix ${schedule.target})`);

  if (!options.simulation) {
    return runCutoverOnRpc(options, deps, schedule);
  }

  if (currentEpoch < effectiveEpoch) {
    log(`DRY_RUN: advancing a disposable fork to unix ${schedule.target + 1}`);
  } else {
    log('DRY_RUN: simulating on a disposable fork at the current chain time');
  }
  const fork = deps.withFork ?? withAnvilFork;
  return fork({
    forkUrl: options.rpcUrl,
    chainId: options.chainId,
    timestamp: currentEpoch < effectiveEpoch ? schedule.target + 1 : undefined,
  }, ({ rpcUrl }) => runCutoverOnRpc({ ...options, rpcUrl, simulation: true }, deps, schedule));
}
