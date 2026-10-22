// The numbers on a profile's share card, read server-side: this week's points
// for every linked wallet from Antscan, the buyer pot from chain, and the rank
// among this epoch's buyers. The maths is src/lib/points.ts, the same the
// profile page uses, so the image and the page always agree.
import { readUsagePots } from '../../src/lib/chain';
import { antsFromWei, epochAt, epochEndMs, pointsFromWeighted, projectRange } from '../../src/lib/points';

export const ANTSCAN = 'https://antscan.co';

/** Same shape as ShareCardData in src/lib/shareCard.ts; ants is null if the pot couldn't be read. */
export interface CardData {
  handle: string;
  name: string;
  avatar?: string;
  epoch: number;
  points: number;
  ants: number | null;
  rank: { rank: number; of: number } | null;
}

interface Participant {
  currentEpoch: string;
  buyer: { epoch: string; weightedPoints: string }[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${ANTSCAN}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Antscan ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

async function buyerRank(epoch: number, weighted: bigint): Promise<{ rank: number; of: number }> {
  const res = await fetch(`${ANTSCAN}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query($e: BigInt!, $w: BigInt!) { above: buyerEpochs(where: { epoch: $e, weightedPoints_gt: $w }, limit: 1) { totalCount } all: buyerEpochs(where: { epoch: $e }, limit: 1) { totalCount } }`,
      variables: { e: String(epoch), w: weighted.toString() },
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Antscan GraphQL answered ${res.status}`);
  const body = (await res.json()) as { data?: { above: { totalCount: number }; all: { totalCount: number } } };
  if (!body.data) throw new Error('Antscan GraphQL returned no data');
  return { rank: body.data.above.totalCount + 1, of: body.data.all.totalCount };
}

export async function loadCardData(profile: { handle: string; name: string; avatar?: string; addresses: string[] }): Promise<CardData> {
  const parts = await Promise.all(profile.addresses.map((a) => get<Participant>(`/api/staking/participants/${a.toLowerCase()}?epochs=1`)));
  const epoch = Number(parts[0]?.currentEpoch) || epochAt(Date.now());
  const mine = parts.map((p) => BigInt(p.buyer.find((b) => Number(b.epoch) === epoch)?.weightedPoints || '0'));
  const weighted = mine.reduce((t, w) => t + w, 0n);

  const [epochs, pot, rank] = await Promise.all([
    get<{ epoch: string; totalWeightedBuyerPoints: string }[]>('/api/staking/epochs?limit=3').catch(() => null),
    readUsagePots(epoch).then((p) => antsFromWei(p.buyerPot)).catch(() => null),
    weighted > 0n ? buyerRank(epoch, weighted).catch(() => null) : null,
  ]);
  const total = epochs?.find((e) => Number(e.epoch) === epoch)?.totalWeightedBuyerPoints;
  // Like the profile page: projected to Thursday at this week's pace, each wallet capped on its own, then summed.
  const totalPoints = total === undefined ? 0 : pointsFromWeighted(total);
  const leftMs = Math.max(0, epochEndMs(epoch) - Date.now());
  const elapsedMs = Math.max(0, 7 * 86_400_000 - leftMs);
  const ants = pot === null || total === undefined
    ? null
    : mine.reduce((t, w) => t + projectRange({ potAnts: pot, totalPoints, myPoints: pointsFromWeighted(w), alreadyCounted: true, elapsedMs, leftMs, busyPointsPerDay: 0 }).expected, 0);

  return {
    handle: profile.handle,
    name: profile.name,
    avatar: profile.avatar || undefined,
    epoch,
    points: mine.reduce((t, w) => t + pointsFromWeighted(w), 0),
    ants,
    rank,
  };
}
