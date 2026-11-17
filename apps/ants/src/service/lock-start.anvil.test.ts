import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AbiCoder, Contract, ContractFactory, JsonRpcProvider, keccak256, toBeHex, type JsonRpcSigner } from 'ethers';
import { MULTICALL3_ADDRESS, projectedEarlyExitSlashBps } from '@antseed/node/payments';
import { earlyExitSlashBpsFrom, normalLockStarts, type LineageRow, type LockHistory } from './lock-start.js';
import { mergeLockStartProblem } from '../position-actions.js';

/**
 * Differential test of the rebuilt normal lock start against the real
 * `AntseedSellerPools` on a private Anvil chain. Random seeded sequences of
 * stake, reward restake, split, merge, move, extend, max-lock enable/disable,
 * withdraw and epoch steps run on chain; at every epoch step the app's
 * `normalLockStarts` is compared with
 *   - the pool's private `_positionNormalStartEpoch` checkpoint (read from storage),
 *   - the pool's `earlyExitSlashBps` view, through the same projection the positions API uses,
 *   - a simulated `mergeStakes` for every pair the merge dialog could offer.
 *
 * Opt-in: needs `anvil` and `forge build` artifacts in packages/contracts/out.
 *   cd packages/contracts && forge build
 *   ANTS_ANVIL_DIFFERENTIAL=1 pnpm --filter @antseed/ants exec vitest run src/service/lock-start.anvil.test.ts
 * ANTS_ANVIL_SEEDS (default 12) and ANTS_ANVIL_OPS (default 160) size the run;
 * ANTS_ANVIL_NO_MULTICALL=1 runs without Multicall3, as a bare local chain does.
 */

const CONTRACTS = fileURLToPath(new URL('../../../../packages/contracts/', import.meta.url));
const ENABLED = process.env.ANTS_ANVIL_DIFFERENTIAL === '1';
const SEEDS = Number(process.env.ANTS_ANVIL_SEEDS ?? 12);
const OPS = Number(process.env.ANTS_ANVIL_OPS ?? 160);
const WITH_MULTICALL = process.env.ANTS_ANVIL_NO_MULTICALL !== '1';
const E18 = 10n ** 18n;
const coder = AbiCoder.defaultAbiCoder();

function artifact(file: string, name: string): { abi: unknown[]; bytecode: string } {
  const json = JSON.parse(readFileSync(`${CONTRACTS}out/${file}/${name}.json`, 'utf8')) as { abi: unknown[]; bytecode: { object: string } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** Seeded PRNG (mulberry32), so a failing seed replays exactly. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Track { closedBy?: 'split' | 'merge' | 'move' | 'withdraw'; replacementIds?: number[]; sameEpochToggle?: boolean; disabledEpoch?: number; disableThenRestructure?: boolean; createdEpoch?: number; tags?: string[] }
interface Chain { epoch: number; positions: Map<number, { agentId: number; amount: bigint; stakeStartEpoch: number; stakeEndEpoch: number; closedAtEpoch: number; withdrawn: boolean }> }

export interface DifferentialStats {
  checks: number; known: number; unknownMaxLocked: number; unknownToggle: number; unknownDisableThenRestructure: number; unknownCappedExtend: number; unknownOther: string[]; wrongStart: string[]; wrongStartToggle: string[];
  slashCompared: number; slashMismatchKnown: string[]; slashMismatchUnknown: number; slashMismatchPending: number;
  pairs: number; blockedReverted: number; falseBlock: string[]; allowedOk: number; allowedRevertedUnknown: number; allowedRevertedKnownEqual: string[];
  ops: Record<string, number>;
  /** Correct known starts per path the brief names, so a run shows it exercised them. */
  paths: Record<string, number>;
}

function emptyStats(): DifferentialStats {
  return {
    checks: 0, known: 0, unknownMaxLocked: 0, unknownToggle: 0, unknownDisableThenRestructure: 0, unknownCappedExtend: 0, unknownOther: [], wrongStart: [], wrongStartToggle: [],
    slashCompared: 0, slashMismatchKnown: [], slashMismatchUnknown: 0, slashMismatchPending: 0,
    pairs: 0, blockedReverted: 0, falseBlock: [], allowedOk: 0, allowedRevertedUnknown: 0, allowedRevertedKnownEqual: [],
    ops: {},
    paths: {},
  };
}

describe.skipIf(!ENABLED)('normal lock start vs the real pool (Anvil differential)', () => {
  let anvil: ChildProcess;
  let provider: JsonRpcProvider;
  let normalStartSlot: bigint;

  beforeAll(async () => {
    if (!existsSync(`${CONTRACTS}out/AntseedSellerPools.sol/AntseedSellerPools.json`)) throw new Error('Run `forge build` in packages/contracts first');
    const layout = JSON.parse(execFileSync('forge', ['inspect', 'AntseedSellerPools', 'storageLayout', '--json'], { cwd: CONTRACTS, encoding: 'utf8' })) as { storage: Array<{ label: string; slot: string }> };
    normalStartSlot = BigInt(layout.storage.find(entry => entry.label === '_positionNormalStartEpoch')!.slot);
    const port = await freePort();
    anvil = spawn('anvil', ['--port', String(port), '--silent', '--disable-code-size-limit', '--gas-limit', '300000000', '--accounts', '5'], { stdio: 'ignore' });
    provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
    for (let attempt = 0; ; attempt++) {
      try { await provider.getBlockNumber(); break; } catch (error) { if (attempt > 100) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  }, 60_000);

  afterAll(() => { anvil?.kill(); });

  async function deploy(signer: JsonRpcSigner, file: string, name: string, args: unknown[] = []): Promise<Contract> {
    const { abi, bytecode } = artifact(file, name);
    const contract = await new ContractFactory(abi as never, bytecode, signer).deploy(...args);
    await contract.waitForDeployment();
    return contract as Contract;
  }

  const opLog: string[] = [];
  async function send(promise: Promise<{ wait: () => Promise<unknown>; data?: string; to?: string }>): Promise<unknown> {
    const tx = await promise;
    const receipt = await tx.wait();
    if (process.env.ANTS_ANVIL_DEBUG && tx.data) opLog.push(tx.data.slice(0, 10) + ' ' + tx.data.slice(10).match(/.{64}/g)?.map(word => BigInt('0x' + word).toString()).join(','));
    return receipt;
  }

  async function runSeed(seed: number, activationDelay: number, stats: DifferentialStats): Promise<void> {
    const random = rng(seed);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
    const [deployer, seller1, seller2, staker] = await Promise.all([0, 1, 2, 3].map(index => provider.getSigner(index)));
    const snapshot = await provider.send('evm_snapshot', []);
    try {
      if (WITH_MULTICALL) {
        const multicall = await deploy(deployer!, 'MockMulticall3.sol', 'MockMulticall3');
        await provider.send('anvil_setCode', [MULTICALL3_ADDRESS, await provider.getCode(await multicall.getAddress())]);
      } else {
        await provider.send('anvil_setCode', [MULTICALL3_ADDRESS, '0x']);
      }
      const registry = await deploy(deployer!, 'AntseedRegistry.sol', 'AntseedRegistry');
      const identity = await deploy(deployer!, 'MockERC8004Registry.sol', 'MockERC8004Registry');
      const token = await deploy(deployer!, 'ANTSToken.sol', 'ANTSToken');
      const gate = await deploy(deployer!, 'MockVerificationEmissionsGate.sol', 'MockVerificationEmissionsGate');
      await send(token.getFunction('setRegistry')(await registry.getAddress()));
      await send(registry.getFunction('setAntsToken')(await token.getAddress()));
      await send(registry.getFunction('setEmissions')(await deployer!.getAddress()));
      await send(registry.getFunction('setIdentityRegistry')(await identity.getAddress()));
      await send(gate.getFunction('setCurrentEpoch')(3));
      const pools = await deploy(deployer!, 'AntseedSellerPools.sol', 'AntseedSellerPools', [await token.getAddress(), await gate.getAddress(), await identity.getAddress(), '0x0000000000000000000000000000000000000000']);
      const poolsAddress = await pools.getAddress();
      await send(token.getFunction('setTransferWhitelist')(poolsAddress, true));
      const sellerRegistry = await deploy(deployer!, 'AntseedSellerRegistry.sol', 'AntseedSellerRegistry', [await identity.getAddress(), poolsAddress, '0x0000000000000000000000000000000000000000']);
      await send(registry.getFunction('setStaking')(await sellerRegistry.getAddress()));
      await send(pools.getFunction('setStakingSource')(await sellerRegistry.getAddress()));
      await send(pools.getFunction('setPoolConfig')(1, activationDelay, 5_000, 500));
      await send(pools.getFunction('setRewardStaker')(await deployer!.getAddress(), true));
      const agents: number[] = [];
      for (const seller of [seller1!, seller2!]) {
        const asSeller = identity.connect(seller) as Contract;
        const agentId = Number(await asSeller.getFunction('register').staticCall());
        await send(asSeller.getFunction('register')());
        await send((sellerRegistry.connect(seller) as Contract).getFunction('registerSeller')(agentId));
        agents.push(agentId);
      }
      await send(token.getFunction('mint')(await staker!.getAddress(), 1_000_000n * E18));
      await send(token.getFunction('setTransferWhitelist')(await staker!.getAddress(), true));
      await send((token.connect(staker!) as Contract).getFunction('approve')(poolsAddress, 2n ** 255n));
      const config = {
        maxStakeEpochs: Number(await pools.getFunction('MAX_STAKE_EPOCHS')()),
        maxSlashBps: Number(await pools.getFunction('maxSlashBps')()), minEarlyExitSlashBps: Number(await pools.getFunction('minEarlyExitSlashBps')()),
      };

      const asStaker = pools.connect(staker!) as Contract;
      const stakerAddress = await staker!.getAddress();
      const tracks = new Map<number, Track>();
      const allIds: number[] = [];
      const cache = new Map<string, LockHistory>();
      const toggledThisEpoch = new Set<number>();
      const enabledThisEpoch = new Set<number>();

      const created = (receipt: unknown): number[] => {
        const logs = (receipt as { logs: Array<{ topics: string[]; data: string }> }).logs;
        return logs.map(log => { try { return pools.interface.parseLog(log); } catch { return null; } })
          .filter(parsed => parsed?.name === 'StakeCreated').map(parsed => Number(parsed!.args[0]));
      };
      const closedPositions = new Map<number, Chain['positions'] extends Map<number, infer V> ? V : never>();
      const read = async (): Promise<Chain> => {
        const epoch = Number(await gate.getFunction('currentEpoch')());
        const positions = new Map<number, Chain['positions'] extends Map<number, infer V> ? V : never>();
        for (const id of allIds) {
          const settled = closedPositions.get(id);
          if (settled) { positions.set(id, settled); continue; }
          const raw = await pools.getFunction('positions')(id) as unknown as [string, bigint, bigint, bigint, bigint, bigint, bigint, boolean];
          const position = { agentId: Number(raw[1]), amount: raw[2], stakeStartEpoch: Number(raw[4]), stakeEndEpoch: Number(raw[5]), closedAtEpoch: Number(raw[6]), withdrawn: raw[7] };
          positions.set(id, position);
          // A closed or withdrawn position never changes again.
          if (position.closedAtEpoch !== 0 || position.withdrawn) closedPositions.set(id, position);
        }
        return { epoch, positions };
      };
      const open = (chain: Chain) => [...chain.positions].filter(([, position]) => position.closedAtEpoch === 0 && !position.withdrawn).map(([id]) => id);
      const maxLockedAt = async (id: number, epoch: number) => (await pools.getFunction('positionMaxLockPowerAtEpoch')(id, epoch) as bigint) !== 0n;
      const normalStartAt = async (id: number, epoch: number): Promise<number> => {
        const base = BigInt(keccak256(coder.encode(['uint256', 'uint256'], [id, normalStartSlot])));
        const length = Number(BigInt(await provider.getStorage(poolsAddress, base)));
        const data = BigInt(keccak256(toBeHex(base, 32)));
        let value = 0;
        for (let index = 0; index < length; index++) {
          const key = Number(BigInt(await provider.getStorage(poolsAddress, data + 2n * BigInt(index))));
          if (key > epoch) break;
          value = Number(BigInt(await provider.getStorage(poolsAddress, data + 2n * BigInt(index) + 1n)));
        }
        return value;
      };
      const inherit = (sources: number[], replacements: number[], closedBy: Track['closedBy'], epoch: number) => {
        const toggle = sources.some(id => tracks.get(id)?.sameEpochToggle);
        // Max lock disabled and the position restructured in the same epoch (the pool's documented flow).
        const disableThenRestructure = sources.some(id => tracks.get(id)?.disabledEpoch === epoch || tracks.get(id)?.disableThenRestructure);
        const tags = new Set(sources.flatMap(id => tracks.get(id)?.tags ?? []));
        if (closedBy === 'merge') tags.add('merged');
        if (closedBy === 'move') tags.add('moved');
        if (closedBy === 'split' && sources.some(id => tracks.get(id)?.tags?.includes('merged'))) tags.add('split of merged');
        if (sources.some(id => tracks.get(id)?.createdEpoch === epoch)) tags.add('same-epoch restructure chain');
        if (disableThenRestructure) tags.add('disable then restructure in one epoch');
        for (const id of sources) tracks.set(id, { ...tracks.get(id), closedBy, replacementIds: replacements });
        for (const id of replacements) tracks.set(id, { sameEpochToggle: toggle, disableThenRestructure, createdEpoch: epoch, tags: [...tags] });
        allIds.push(...replacements);
      };

      const check = async () => {
        const chain = await read();
        const ids = open(chain);
        if (ids.length === 0) return;
        const lineage: LineageRow[] = allIds.map(id => {
          const position = chain.positions.get(id)!;
          const track = tracks.get(id);
          return { id, stakeStartEpoch: position.stakeStartEpoch, closedAtEpoch: position.closedAtEpoch, closedBy: track?.closedBy ?? null, replacementIds: track?.replacementIds ?? [] };
        });
        const starts = await normalLockStarts(provider, poolsAddress, ids, lineage, chain.epoch, cache, config);
        const label = (id: number) => `seed ${seed} delay ${activationDelay} epoch ${chain.epoch} #${id}`;
        const lockedNext = new Map<number, boolean>();
        for (const id of ids) {
          stats.checks++;
          const position = chain.positions.get(id)!;
          const at = Math.max(chain.epoch + 1, position.stakeStartEpoch);
          const truth = await normalStartAt(id, at);
          const locked = await maxLockedAt(id, at);
          lockedNext.set(id, locked);
          const app = starts.get(id) ?? null;
          if (app === null) {
            if (locked) stats.unknownMaxLocked++;
            else if (tracks.get(id)?.sameEpochToggle) stats.unknownToggle++;
            else if (tracks.get(id)?.disableThenRestructure) stats.unknownDisableThenRestructure++;
            else if (tracks.get(id)?.tags?.includes('extend to the cap')) stats.unknownCappedExtend++;
            else stats.unknownOther.push(`${label(id)} (pool ${truth})`);
          } else {
            stats.known++;
            // Max lock enabled and disabled in one epoch leaves no max-lock power checkpoint (the PR's documented gap).
            if (app !== truth) (tracks.get(id)?.sameEpochToggle ? stats.wrongStartToggle : stats.wrongStart).push(`${label(id)}: app ${app}, pool ${truth}`);
            else {
              for (const tag of tracks.get(id)?.tags ?? []) stats.paths[tag] = (stats.paths[tag] ?? 0) + 1;
              if (tracks.get(id)?.sameEpochToggle) stats.paths['same-epoch toggle'] = (stats.paths['same-epoch toggle'] ?? 0) + 1;
            }
          }
          let poolSlash: number;
          try { poolSlash = Number(await pools.getFunction('earlyExitSlashBps')(id)); } catch { continue; }
          stats.slashCompared++;
          const lockedNow = await maxLockedAt(id, Math.max(chain.epoch, position.stakeStartEpoch));
          const view = { ...position, id, owner: stakerAddress, weightAmount: 0n };
          const appSlash = app !== null ? earlyExitSlashBpsFrom(view, app, chain.epoch, config, lockedNow) : projectedEarlyExitSlashBps(view, chain.epoch, config, lockedNow);
          if (appSlash === poolSlash) continue;
          let withdrawable = true;
          try { await provider.call({ from: stakerAddress, to: poolsAddress, data: pools.interface.encodeFunctionData('withdrawStake', [id]) }); } catch { withdrawable = false; }
          if (!withdrawable) stats.slashMismatchPending++;
          else if (app === null) stats.slashMismatchUnknown++;
          else stats.slashMismatchKnown.push(`${label(id)}: app ${appSlash} bps, pool ${poolSlash} bps (start ${app})`);
        }
        const groups = new Map<string, number[]>();
        for (const id of ids) {
          if (lockedNext.get(id)) continue;
          const position = chain.positions.get(id)!;
          if (position.stakeEndEpoch <= chain.epoch + 1) continue;
          const key = `${position.agentId}:${position.stakeEndEpoch}`;
          groups.set(key, [...(groups.get(key) ?? []), id]);
        }
        for (const group of groups.values()) {
          for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
              const pair = [group[i]!, group[j]!];
              stats.pairs++;
              let accepted = true;
              try { await provider.call({ from: stakerAddress, to: poolsAddress, data: pools.interface.encodeFunctionData('mergeStakes', [pair]) }); } catch { accepted = false; }
              const known = pair.map(id => starts.get(id) ?? null);
              const blocked = mergeLockStartProblem(known.map(normalStartEpoch => ({ normalStartEpoch }))) !== null;
              if (blocked && !accepted) stats.blockedReverted++;
              else if (blocked && accepted) stats.falseBlock.push(`seed ${seed} delay ${activationDelay} epoch ${chain.epoch} [${pair}] starts ${known}`);
              else if (accepted) stats.allowedOk++;
              else if (known.some(start => start === null)) stats.allowedRevertedUnknown++;
              else stats.allowedRevertedKnownEqual.push(`seed ${seed} delay ${activationDelay} epoch ${chain.epoch} [${pair}] starts ${known}`);
            }
          }
        }
      };

      let currentOp = '';
      const attempt = async (name: string, action: () => Promise<void>) => {
        currentOp = name;
        try { await action(); stats.ops[name] = (stats.ops[name] ?? 0) + 1; } catch (error) {
          stats.ops[`${name}:reverted`] = (stats.ops[`${name}:reverted`] ?? 0) + 1;
          if (process.env.ANTS_ANVIL_DEBUG) console.log(name, error instanceof Error ? error.message.slice(0, 300) : error);
        }
      };

      for (let op = 0; op < OPS; op++) {
        const chain = await read();
        const ids = open(chain);
        const roll = random();
        if (ids.length < 3 || roll < 0.14) {
          await attempt('stake', async () => {
            const epochs = random() < 0.15 ? 104 : 2 + Math.floor(random() * 12);
            const receipt = await send(asStaker.getFunction('stake')(pick(agents), BigInt(1 + Math.floor(random() * 100)) * E18, epochs));
            const [id] = created(receipt);
            tracks.set(id!, {});
            allIds.push(id!);
          });
        } else if (roll < 0.2) {
          await attempt('restake', async () => {
            const source = pick(allIds);
            const receipt = await send(pools.getFunction('stakeMintedReward')(stakerAddress, source, 10n * E18, 2 + Math.floor(random() * 12)));
            const [id] = created(receipt);
            tracks.set(id!, {});
            allIds.push(id!);
          });
        } else if (roll < 0.3) {
          await attempt('split', async () => {
            const id = pick(ids);
            const amount = chain.positions.get(id)!.amount;
            const receipt = await send(asStaker.getFunction('splitStake')(id, amount * BigInt(1 + Math.floor(random() * 98)) / 100n));
            inherit([id], created(receipt), 'split', chain.epoch);
          });
        } else if (roll < 0.45) {
          await attempt('merge', async () => {
            const groups = new Map<string, number[]>();
            for (const id of ids) {
              const position = chain.positions.get(id)!;
              const key = `${position.agentId}:${position.stakeEndEpoch}`;
              groups.set(key, [...(groups.get(key) ?? []), id]);
            }
            const candidates = [...groups.values()].filter(group => group.length > 1);
            const group = candidates.length > 0 && random() < 0.85 ? pick(candidates) : ids;
            const chosen = [...group].sort(() => random() - 0.5).slice(0, random() < 0.8 ? 2 : 3);
            if (chosen.length < 2) throw new Error('nothing to merge');
            const receipt = await send(asStaker.getFunction('mergeStakes')(chosen));
            inherit(chosen, created(receipt), 'merge', chain.epoch);
          });
        } else if (roll < 0.51) {
          await attempt('move', async () => {
            const id = pick(ids);
            const to = agents.find(agent => agent !== chain.positions.get(id)!.agentId)!;
            const receipt = await send(asStaker.getFunction('moveStake')(id, to));
            inherit([id], created(receipt), 'move', chain.epoch);
          });
        } else if (roll < 0.61) {
          await attempt('extend', async () => {
            const id = pick(ids);
            const position = chain.positions.get(id)!;
            const longer = ids.map(other => chain.positions.get(other)!).filter(other => other.agentId === position.agentId && other.stakeEndEpoch > position.stakeEndEpoch);
            const additional = longer.length > 0 && random() < 0.6 ? pick(longer).stakeEndEpoch - position.stakeEndEpoch : 1 + Math.floor(random() * 6);
            await send(asStaker.getFunction('extendLock')(id, additional));
            const track = tracks.get(id) ?? {};
            const tags = [...track.tags ?? []];
            if (tags.includes('moved')) tags.push('extend after move');
            // An extend to the cap reads like max lock enabled and disabled in one epoch; the pool's slash decides it.
            const end = Number((await pools.getFunction('positions')(id) as unknown as bigint[])[5]);
            if (end === Math.max(chain.epoch + 1, position.stakeStartEpoch) + 104) tags.push('extend to the cap');
            tracks.set(id, { ...track, tags });
          });
        } else if (roll < 0.68) {
          await attempt('enableMaxLock', async () => {
            const id = pick(ids);
            await send(asStaker.getFunction('enableMaxLock')(id));
            enabledThisEpoch.add(id);
          });
        } else if (roll < 0.76) {
          await attempt('disableMaxLock', async () => {
            const locked: number[] = [];
            for (const id of ids) if (await maxLockedAt(id, chain.epoch + 1)) locked.push(id);
            if (locked.length === 0) throw new Error('nothing max locked');
            const id = pick(locked);
            await send(asStaker.getFunction('disableMaxLock')(id));
            const before = tracks.get(id) ?? {};
            tracks.set(id, { ...before, disabledEpoch: chain.epoch, tags: before.tags?.includes('merged') ? [...before.tags, 'disable after merge'] : before.tags });
            if (enabledThisEpoch.has(id)) { toggledThisEpoch.add(id); tracks.set(id, { ...tracks.get(id), sameEpochToggle: true }); }
            // Disable-then-restructure in one epoch, as the pool's own docs suggest.
            if (random() < 0.5) {
              const receipt = await send(asStaker.getFunction('splitStake')(id, chain.positions.get(id)!.amount / 2n));
              inherit([id], created(receipt), 'split', chain.epoch);
            }
          });
        } else if (roll < 0.79) {
          await attempt('withdraw', async () => {
            const id = pick(ids);
            await send(asStaker.getFunction('withdrawStake')(id));
            tracks.set(id, { ...tracks.get(id), closedBy: 'withdraw' });
          });
        } else {
          await check();
          await send(gate.getFunction('setCurrentEpoch')(chain.epoch + 1));
          enabledThisEpoch.clear();
          toggledThisEpoch.clear();
          stats.ops.epoch = (stats.ops.epoch ?? 0) + 1;
        }
      }
      await check();
      if (process.env.ANTS_ANVIL_DEBUG) console.log(opLog.join('\n'));
    } finally {
      await provider.send('evm_revert', [snapshot]);
    }
  }

  it('matches the pool for random operation sequences', async () => {
    const stats = emptyStats();
    const only = process.env.ANTS_ANVIL_SEED_ONLY ? Number(process.env.ANTS_ANVIL_SEED_ONLY) : null;
    for (let seed = only ?? 1; seed <= (only ?? SEEDS); seed++) {
      const started = Date.now();
      await runSeed(seed, seed % 3 === 0 ? 2 : 1, stats);
      console.log(`seed ${seed} done in ${Math.round((Date.now() - started) / 1000)}s: ${stats.checks} checks, ${stats.pairs} pairs, ${stats.wrongStart.length} wrong starts`);
    }
    console.log(JSON.stringify({ multicall: WITH_MULTICALL, ...stats, wrongStart: stats.wrongStart.slice(0, 20), wrongStartToggle: stats.wrongStartToggle.slice(0, 5), wrongStartToggleCount: stats.wrongStartToggle.length, slashMismatchKnown: stats.slashMismatchKnown.slice(0, 20), falseBlock: stats.falseBlock.slice(0, 20), unknownOther: stats.unknownOther.slice(0, 20), allowedRevertedKnownEqual: stats.allowedRevertedKnownEqual.slice(0, 20) }, null, 2));
    // A run that checked nothing proves nothing.
    expect(stats.known).toBeGreaterThan(SEEDS * 10);
    expect(stats.pairs).toBeGreaterThan(SEEDS * 5);
    expect(stats.wrongStart).toEqual([]);
    expect(stats.wrongStartToggle).toEqual([]);
    expect(stats.unknownOther).toEqual([]);
    expect(stats.slashMismatchKnown).toEqual([]);
    expect(stats.falseBlock).toEqual([]);
    expect(stats.allowedRevertedKnownEqual).toEqual([]);
  }, 1_800_000);
});
