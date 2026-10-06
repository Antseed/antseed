import type { AntsContext } from './context.js';
import type { SellerView } from '../api-types.js';
import { formatAnts } from './format.js';
import { toJson } from './json.js';
import { assertAgentId, silentReporter, type StepReporter } from './steps.js';


export async function seller(ctx: AntsContext): Promise<SellerView> {
  const stack = await ctx.stack();
  const identity = ctx.identity();
  const registry = ctx.sellerRegistry();
  const legacyStaking = ctx.legacyStakingAt(stack.legacyStaking);
  const pools = ctx.pools();
  const init = ctx.positionInit();

  const [identityRegistered, registryAgentId, legacyAgentId, legacyStake, legacyEligible, registryEligible, legacyEligibilityEnabled, minPoolStake] = await Promise.all([
    identity ? identity.isRegistered(ctx.address) : Promise.resolve(false),
    registry ? registry.getAgentId(ctx.address) : Promise.resolve(0),
    legacyStaking ? legacyStaking.getAgentId(ctx.address) : Promise.resolve(0),
    legacyStaking ? legacyStaking.getStake(ctx.address) : Promise.resolve(0n),
    legacyStaking ? legacyStaking.isStakedAboveMin(ctx.address) : Promise.resolve(false),
    registry ? registry.isStakedAboveMin(ctx.address) : Promise.resolve(false),
    registry ? registry.legacyStakeEligibilityEnabled() : Promise.resolve(null),
    registry ? registry.minSellerPoolStake() : Promise.resolve(null),
  ]);
  const agentId = registryAgentId || legacyAgentId;
  const registryBound = !!registry && registryAgentId !== 0 &&
    (await registry.agentSeller(registryAgentId)).toLowerCase() === ctx.address.toLowerCase();
  const poolActiveStake = pools && agentId ? await pools.poolActiveStakeAtEpoch(agentId, stack.currentEpoch) : 0n;

  let starter: SellerView['starter'] = null;
  if (init && pools) {
    const [initialized, remaining, amount, endEpoch, activationDelay] = await Promise.all([
      agentId ? init.agentInitialized(agentId) : Promise.resolve(false),
      init.remainingInits(), init.initAmount(), init.initEndEpoch(), pools.stakeActivationDelay(),
    ]);
    const legacyStarterEligible = legacyAgentId !== 0 && legacyEligible;
    const expired = stack.currentEpoch + activationDelay >= endEpoch;
    starter = {
      contract: init.contractAddress, initialized, remaining: remaining.toString(), amount: amount.toString(), endEpoch,
      legacyEligible: legacyStarterEligible, expired, claimable: legacyStarterEligible && !initialized && !expired && remaining > 0n,
    };
  }

  return toJson({
    address: ctx.address,
    agentId,
    identityRegistered,
    registryBound,
    eligible: stack.phase === 'active' ? registryEligible : legacyEligible,
    legacyStake: legacyStake.toString(),
    legacyEligibilityEnabled,
    minPoolStake: minPoolStake === null ? null : minPoolStake.toString(),
    poolActiveStake: poolActiveStake.toString(),
    starter,
  });
}

export async function registerBinding(ctx: AntsContext, agentIdInput?: number, report: StepReporter = silentReporter): Promise<{ agentId: number; sent: boolean }> {
  const signer = ctx.requireSigner();
  const registry = ctx.sellerRegistry();
  if (!registry) throw new Error('Seller registry is not configured; use `antseed seller register` on this chain.');
  const stack = await ctx.stack();
  const legacyStaking = ctx.legacyStakingAt(stack.legacyStaking);
  const identity = ctx.identity();
  if (!identity) throw new Error('The identity registry is not configured for this chain.');
  let agentId = agentIdInput === undefined ? await registry.getAgentId(ctx.address) : assertAgentId(agentIdInput);
  if (!agentId && legacyStaking) agentId = await legacyStaking.getAgentId(ctx.address);
  let sent = false;
  if (!agentId) {
    if (await identity.isRegistered(ctx.address)) {
      throw new Error('This wallet already owns an identity. Enter its agent ID to finish binding; check Activity if a previous registration stopped partway through.');
    }
    await report('Creating an ERC-8004 identity');
    agentId = await identity.register(signer);
    sent = true;
    assertAgentId(agentId);
    await report(`Identity created: agent ${agentId}. If binding fails, retry with this agent ID.`);
  }
  const owner = await identity.getAgentWallet(agentId);
  if (owner.toLowerCase() !== ctx.address.toLowerCase()) throw new Error(`Agent ${agentId} is owned by ${owner}, not this wallet.`);
  await report(`Binding agent ${agentId} to ${ctx.address} in the seller registry`);
  await registry.registerSellerBinding(signer, agentId, async (hash) => { sent = true; await report('Registration confirmed', hash); });
  if (!sent) await report('Registration already complete; nothing sent');
  ctx.invalidate();
  return { agentId, sent };
}

export async function claimStarter(ctx: AntsContext, report: StepReporter = silentReporter): Promise<{ hash: string; agentId: number; amount: string; endEpoch: number }> {
  const signer = ctx.requireSigner();
  const init = ctx.positionInit();
  if (!init) throw new Error('Starter positions are not configured for this chain.');
  const view = await seller(ctx);
  if (!view.starter) throw new Error('Starter positions are unavailable.');
  if (view.starter.initialized) throw new Error(`Starter position already initialized for agent ${view.agentId}.`);
  if (!view.starter.legacyEligible) throw new Error('Starter grants require a legacy USDC stake at or above the minimum bound to this wallet.');
  if (view.starter.expired) throw new Error(`Starter initialization closed at epoch ${view.starter.endEpoch}.`);
  if (BigInt(view.starter.remaining) === 0n) throw new Error('The starter faucet is depleted.');
  await report(`Creating ${formatAnts(view.starter.amount)} ANTS starter position for agent ${view.agentId} (locked through epoch ${view.starter.endEpoch})`);
  const hash = await init.initPosition(signer);
  await report('Starter position created', hash);
  ctx.invalidate();
  return { hash, agentId: view.agentId, amount: view.starter.amount, endEpoch: view.starter.endEpoch };
}
