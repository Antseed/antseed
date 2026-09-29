import { GATE_MINTERS, gateMinterId } from '@antseed/node/payments';
import type { AntsContext } from './context.js';
import type { EmissionsView, MinterView } from '../api-types.js';
import { toJson } from './json.js';


export async function emissions(ctx: AntsContext): Promise<EmissionsView> {
  const stack = await ctx.stack();
  const gate = ctx.gate();
  const legacy = ctx.legacyEmissionsAt(stack.legacyEmissions);
  const poolRewards = ctx.poolRewards();
  const usageRewards = ctx.usageRewards();

  let view: Omit<EmissionsView, 'legacy' | 'dynamicStaker' | 'dynamicUsage'>;
  if (gate) {
    const epoch = stack.currentEpoch;
    const [halvingInterval, initialEmission, currentRate, cumulative, shareDenominator, emissionsReserve, legacyEscrow] = await Promise.all([
      gate.halvingInterval(), gate.initialEmission(), gate.currentEmissionRate(), gate.cumulativeEmissionThrough(epoch + 1),
      gate.shareDenominator(), gate.emissionsReserve(), gate.legacyEscrow(),
    ]);
    const minters: MinterView[] = await Promise.all(GATE_MINTERS.map(async (minter) => {
      const id = gateMinterId(minter.id);
      const [info, budget] = await Promise.all([
        gate.minter(id),
        gate.minterEpochBudget(id, Math.max(epoch, stack.effectiveEpoch ?? epoch)),
      ]);
      return { name: minter.name, id, controller: info.controller, shareBps: info.shareBps, editable: info.editable, epochBudget: budget.toString() };
    }));
    view = {
      currentEpoch: epoch, effectiveEpoch: stack.effectiveEpoch, genesis: stack.genesis, epochDuration: stack.epochDuration, halvingInterval,
      initialEmission: initialEmission.toString(), currentRate: currentRate.toString(), cumulativeThroughCurrent: cumulative.toString(),
      shareDenominator, minters, emissionsReserve, legacyEscrow,
    };
  } else {
    if (!legacy) throw new Error('No emissions contract configured.');
    const [halvingInterval, initialEmission, info] = await Promise.all([legacy.getHalvingInterval(), legacy.getEpochEmission(0), legacy.getEpochInfo()]);
    view = {
      currentEpoch: stack.currentEpoch, effectiveEpoch: null, genesis: stack.genesis, epochDuration: stack.epochDuration, halvingInterval,
      initialEmission: initialEmission.toString(), currentRate: info.emission.toString(), cumulativeThroughCurrent: '0', shareDenominator: 100, minters: [],
      emissionsReserve: null, legacyEscrow: null,
    };
  }

  const dynamicStaker = poolRewards ? await (async () => {
    const config = await poolRewards.dynamicStakerConfigAt(stack.currentEpoch);
    return { minShareBps: config.minShareBps, maxShareBps: config.maxShareBps, stakeShareTarget: config.stakeShareTarget.toString() };
  })() : null;
  const dynamicUsage = usageRewards ? await (async () => {
    const config = await usageRewards.dynamicUsageConfigAt(stack.currentEpoch);
    return { ...config, volumeShareTarget: config.volumeShareTarget.toString() };
  })() : null;
  const legacyView = legacy && stack.legacyEmissions ? await (async () => {
    const [shares, info] = await Promise.all([legacy.getShares(), legacy.getEpochInfo()]);
    return { contract: stack.legacyEmissions!, sellerPct: shares.sellerSharePct, buyerPct: shares.buyerSharePct, reservePct: shares.reserveSharePct, teamPct: shares.teamSharePct, currentEpoch: info.epoch };
  })() : null;

  return toJson({ ...view, dynamicStaker, dynamicUsage, legacy: legacyView });
}
