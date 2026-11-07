// The buyer CLI's read commands on the testbench buyer's data dir after two paid chats, each transcript compared with
// the buyer proxy (/_antseed/channels, /_antseed/buyer-usage) and the chain (tb.buyerBalance()).
//
// Runs in cli mode, where the buyer is its own `antseed buyer start` process. Every command here is safe next to it:
// status, balance, channels (and channels list), connection get, identity list, metering and activity only read the
// data dir's stores and the chain. `buyer status` and `buyer channels` reconcile stale store rows on-chain, but leave
// each seller's current channel to the running buyer while buyer.state.json's pid is alive (issue-1050 covers the
// stopped-buyer case on a copy of the dir). The scenario checks the buyer still serves, and its channels view is
// unchanged, after the commands ran. It ends with `buyer emissions info` across an epoch boundary (tb.warpToNextEpoch):
// the CLI must see the same contract stack and epoch as the chain.
export const meta = {
  description: 'antseed buyer status, balance, channels, connection, identity, metering, activity and emissions run against the running buyer\'s data dir after two paid chats; every transcript matches the proxy and the chain (stack, epoch, balances), exits 0 and prints no stack trace.',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
  covers: [
    'buyer CLI commands (apps/cli/src/cli/commands/buyer)',
    'the CLI feature recipe (.claude/skills/verify-antseed/features/cli.md) as a scripted check',
  ],
};

export const topology = {
  mode: 'cli',
  sellers: [{ id: 'seller' }],
};

/** A stack trace or an uncaught error in a CLI's stderr; spinner and progress lines are fine. */
export function stderrProblems(stderr) {
  return String(stderr ?? '').split('\n').filter((line) => /^\s+at\s.+:\d+:\d+\)?\s*$/.test(line) || /\b(TypeError|ReferenceError|SyntaxError|RangeError|Unhandled|uncaught)\b/i.test(line));
}

/** A decimal USDC string from the CLI ("9.0", "1.00", "0.000036") as micro-USDC; null when it is not one. */
export function micros(value) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value ?? '').trim());
  return match ? BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0')) : null;
}

const WALLET_MICROS = 2_500_000n;

async function proxyJson(tb, path) {
  const reply = await tb.request(path);
  tb.check(`proxy ${path} answers`, reply.status === 200 && reply.json?.ok !== false, { status: reply.status });
  return reply.json;
}

export async function run(tb) {
  const sellerId = tb.sellers[0].id;
  const model = tb.sellers[0].models[0];
  const buyer = tb.manifest.buyer.address;
  await tb.chat({ model, sellerId, prompt: 'first paid chat' });
  await tb.chat({ model, sellerId, prompt: 'second paid chat', stream: true });
  // The second chat's SpendingAuth goes out after its response; wait until the proxy shows both requests signed.
  await tb.waitFor(async () => {
    const channels = (await tb.request('/_antseed/channels')).json?.channels ?? [];
    return channels.reduce((sum, channel) => sum + (channel.requestCount ?? 0), 0) >= 2 && channels.every((channel) => BigInt(channel.cumulativeSigned ?? '0') > 0n);
  }, 'both chats signed', { timeoutMs: 30_000 });

  // A wallet balance next to the deposit, so `buyer balance` has a nonzero walletUSDC to report.
  await tb.mintUsdc(buyer, WALLET_MICROS);
  const proxyChannels = (await proxyJson(tb, '/_antseed/channels')).channels;
  const usage = (await proxyJson(tb, '/_antseed/buyer-usage')).totals;
  const balance = await tb.buyerBalance();
  const state = await tb.chainState();
  const walletUsdc = BigInt(state.buyer.usdcMicro);
  tb.check('tb.chainState() agrees with tb.buyerBalance() and holds the minted wallet USDC', state.buyer.availableMicroUsdc === String(balance.available) && state.buyer.reservedMicroUsdc === String(balance.reserved) && walletUsdc >= WALLET_MICROS, state.buyer);
  const active = proxyChannels.filter((channel) => channel.status === 'active');
  tb.check('the proxy shows one active channel with the seller after two paid chats', active.length === 1 && active[0].peerId === tb.seller(sellerId).peerId, proxyChannels);
  const [channel] = active;
  const signed = BigInt(channel.cumulativeSigned);

  const cli = async (args) => {
    const result = await tb.cli(args, { timeoutMs: 90_000 });
    const problems = stderrProblems(result.stderr);
    tb.check(`antseed ${args.join(' ')} exits 0 without a stack trace`, result.code === 0 && problems.length === 0, { code: result.code, stderr: result.stderr.slice(-600) });
    return result;
  };

  const status = (await cli(['buyer', 'status', '--json'])).json;
  tb.check('buyer status --json: connected on the testbench proxy port, as the testbench wallet', status?.connectionState === 'connected' && status.proxyPort === tb.manifest.proxyPort && status.walletAddress?.toLowerCase() === buyer.toLowerCase() && status.pinnedPeerId === null, status);
  tb.check('buyer status --json: active channels match /_antseed/channels and buyer-usage', status.activeChannels === active.length && status.activeChannels === usage.activeChannels, { cli: status.activeChannels, proxy: active.length, usage: usage.activeChannels });
  tb.check('buyer status --json: deposit available and reserved match the chain', micros(status.depositsAvailable) === balance.available && micros(status.depositsReserved) === balance.reserved, { cli: [status.depositsAvailable, status.depositsReserved], chain: [String(balance.available), String(balance.reserved)] });

  const balanceJson = (await cli(['buyer', 'balance', '--json'])).json;
  tb.check('buyer balance --json: wallet and deposits match the chain', balanceJson?.address?.toLowerCase() === buyer.toLowerCase() && micros(balanceJson.walletUSDC) === walletUsdc && micros(balanceJson.depositsAvailable) === balance.available && micros(balanceJson.depositsReserved) === balance.reserved, { cli: balanceJson, chain: { walletUsdc: String(walletUsdc), available: String(balance.available), reserved: String(balance.reserved) } });

  const channelsJson = (await cli(['buyer', 'channels', '--json'])).json;
  const cliActive = Array.isArray(channelsJson) ? channelsJson.filter((row) => row.status === 'active') : [];
  tb.check('buyer channels --json: the same active channel as the proxy, with its signed total and request count', cliActive.length === 1 && cliActive[0].sessionId === channel.channelId && BigInt(cliActive[0].authMax) === signed && cliActive[0].requestCount === channel.requestCount && cliActive[0].peerId === channel.peerId, { cli: cliActive.map(({ sessionId, authMax, requestCount, peerId }) => ({ sessionId, authMax, requestCount, peerId })), proxy: { channelId: channel.channelId, cumulativeSigned: channel.cumulativeSigned, requestCount: channel.requestCount } });
  const list = await cli(['buyer', 'channels', 'list']);
  tb.check('buyer channels list: names the active channel and its request count', list.stdout.includes(channel.channelId.slice(0, 16)) && new RegExp(`Requests: ${channel.requestCount}\\b`).test(list.stdout) && /\bactive\b/.test(list.stdout), list.stdout.slice(0, 600));
  const listJson = await tb.cli(['buyer', 'channels', 'list', '--json'], { timeoutMs: 90_000 });
  tb.knownIssue('buyer channels list --json prints JSON', listJson.code === 0 && Array.isArray(listJson.json), { code: listJson.code, stdout: listJson.stdout.slice(0, 200) }, 'not filed yet: `buyer channels` and its `list` subcommand both declare --json, and commander gives the flag to `channels`, so `list --json` prints text (apps/cli/src/cli/commands/buyer/channels.ts)');

  const connection = await cli(['buyer', 'connection', 'get']);
  tb.check('buyer connection get: connected on the proxy port, no pinned peer', /State:\s+connected/.test(connection.stdout) && new RegExp(`Port:\\s+${tb.manifest.proxyPort}\\b`).test(connection.stdout) && /Pinned peer:\s+none/.test(connection.stdout), connection.stdout);

  const identities = (await cli(['buyer', 'identity', 'list', '--json', '--balances'])).json;
  const main = Array.isArray(identities) ? identities.find((entry) => entry.name === 'default') : null;
  tb.check('buyer identity list --json --balances: the default identity is the testbench wallet, with the chain\'s deposit', main?.address?.toLowerCase() === buyer.toLowerCase() && micros(main.available) === balance.available && micros(main.reserved) === balance.reserved, identities);

  const metering = (await cli(['buyer', 'metering', '--json'])).json;
  const peer = metering?.[channel.peerId];
  tb.check('buyer metering --json: the seller\'s channel, signed total and requests match the proxy', peer?.channelId === channel.channelId && BigInt(peer.cumulativeSigned) === signed && peer.requests === channel.requestCount && peer.lifetimeRequests === usage.totalRequests, { cli: peer, proxy: { channelId: channel.channelId, cumulativeSigned: channel.cumulativeSigned, requestCount: channel.requestCount, totalRequests: usage.totalRequests } });

  const activity = (await cli(['buyer', 'activity', '--json'])).json;
  const activityChannel = activity?.channels?.find((row) => row.channelId === channel.channelId);
  tb.check('buyer activity --json: usage totals match /_antseed/buyer-usage', activity?.usage?.totalRequests === usage.totalRequests && activity.usage.totalInputTokens === usage.totalInputTokens && activity.usage.totalOutputTokens === usage.totalOutputTokens && activity.usage.activeChannels === usage.activeChannels, { cli: activity?.usage, proxy: usage });
  tb.check('buyer activity --json: the channel and the deposit match the proxy and the chain', BigInt(activityChannel?.cumulativeSigned ?? -1) === signed && activityChannel.status === 'active' && activityChannel.onChainStatus === 1 && BigInt(activity.deposits.available) === balance.available && BigInt(activity.deposits.reserved) === balance.reserved, { cli: { channel: activityChannel, deposits: activity?.deposits }, chain: { available: String(balance.available), reserved: String(balance.reserved) } });

  // The CLI resolves the chain's contract stack from the registry and reads the chain's epoch: recognized usage on
  // the full local layout and on the fork, legacy on the 'payments' layout.
  const chatEpoch = await tb.epoch();
  const expectedMode = tb.contracts.usageAccounting && tb.contracts.staking === tb.contracts.sellerRegistry ? 'recognized-usage' : 'legacy';
  const emissions = (await cli(['buyer', 'emissions', 'info', '--json'])).json;
  tb.check(`buyer emissions info --json: the ${expectedMode} stack, in the chain's epoch`, emissions?.mode === expectedMode && emissions.epoch === chatEpoch && emissions.address?.toLowerCase() === buyer.toLowerCase(), { cli: emissions, epoch: chatEpoch, contracts: { staking: tb.contracts.staking, sellerRegistry: tb.contracts.sellerRegistry } });

  // The commands only read: the running buyer still has the same channel and still serves.
  const after = (await proxyJson(tb, '/_antseed/channels')).channels.filter((row) => row.status === 'active');
  tb.check('the commands left the running buyer\'s channel alone', after.length === 1 && after[0].channelId === channel.channelId && BigInt(after[0].cumulativeSigned) === signed, after);
  await tb.chat({ model, sellerId, prompt: 'chat after the CLI commands' });
  await tb.closeAll();
  await tb.assertSettlementMatchesSigned();

  // Once the epoch is over, the CLI lists it among the epochs the buyer can be rewarded for.
  const warped = await tb.warpToNextEpoch();
  tb.check('tb.warpToNextEpoch() moves the chain into the next epoch', warped.from === chatEpoch && warped.to === chatEpoch + 1 && (await tb.epoch()) === chatEpoch + 1, warped);
  const next = (await cli(['buyer', 'emissions', 'info', '--json'])).json;
  const rewardEpochs = expectedMode === 'recognized-usage' ? next?.recognizedUsage?.epochs : next?.legacy?.epochs;
  tb.check('buyer emissions info --json: after the warp the chat\'s epoch is a past, rewardable epoch', next?.epoch === chatEpoch + 1 && Array.isArray(rewardEpochs) && rewardEpochs.includes(chatEpoch), { cli: next, chatEpoch });
  tb.metric('emissions', { mode: next?.mode, chatEpoch, pendingBuyer: next?.pendingBuyer ?? null });
}
