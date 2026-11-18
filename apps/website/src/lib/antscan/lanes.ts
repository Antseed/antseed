import type {ListPricesResponse, MarketplaceResponse, Offering} from './api.ts';
import {makerOf, type Maker} from './makers.ts';
import {familyKey, pickName} from './names.ts';
import type {LaneModel, MarketView, Medium} from './types.ts';

const MEDIUM_OF_PROTOCOL: Record<string, Medium> = {
  'openai-images': 'image',
  'venice-video': 'video',
  'fal-video': 'video',
  'openai-audio-speech': 'voice',
  'openai-chat-completions': 'text',
  'openai-responses': 'text',
  'anthropic-messages': 'text',
};

/** Cards per lane and per maker in it: popular models, a few from each maker. */
const LANE_SIZE: Record<Medium, number> = {text: 24, image: 14, video: 12, voice: 8};
const PER_MAKER: Record<Medium, number> = {text: 3, image: 2, video: 2, voice: 2};
/** Text models one seller lists are often a reseller's own label, not a model the network carries. */
const MIN_TEXT_PROVIDERS = 2;
const MAX_SAVE = 99;
/** Voice cards show the price per million characters. */
const CHARACTERS_PER_PRICE_UNIT = 1_000_000;
const MEDIA: readonly Medium[] = ['text', 'image', 'video', 'voice'];

/** Each medium's price, in the unit its card shows: $/M tokens, $/image, $/second, $/M characters. */
const UNIT_PRICE: Record<Medium, (o: Offering) => number | null | undefined> = {
  text: (o) => o.inputUsdPerMillion,
  image: (o) => o.unitPrices?.output_images?.minUsd ?? null,
  video: (o) => o.unitPrices?.video_seconds?.minUsd ?? null,
  voice: (o) => {
    const perCharacter = o.unitPrices?.input_characters?.minUsd;
    return perCharacter == null ? null : perCharacter * CHARACTERS_PER_PRICE_UNIT;
  },
};

/** A media protocol wins over a chat one: an image model may also answer chat. */
export function mediumOf(protocols: readonly string[]): Medium | null {
  const media = protocols.map((p) => MEDIUM_OF_PROTOCOL[p]).filter((m): m is Medium => m !== undefined);
  return media.find((m) => m !== 'text') ?? media[0] ?? null;
}

type Family = {maker: Maker; medium: Medium; names: string[]; sellers: Set<string>; price: number | null};

/** Lowest paid price among sellers with on-chain reputation; free listings and unproven sellers don't set it. */
function lowerPrice(current: number | null, offering: Offering, medium: Medium): number | null {
  const price = UNIT_PRICE[medium](offering);
  const proven = (offering.sellerOnChainReputationScore ?? 0) > 0;
  if (!proven || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return current;
  return current === null ? price : Math.min(current, price);
}

function families(offerings: readonly Offering[]): Map<string, Family> {
  const out = new Map<string, Family>();
  for (const o of offerings) {
    const medium = mediumOf(o.protocols);
    const maker = makerOf(o.service);
    if (!medium || !maker) continue;
    const key = `${medium}/${familyKey(o.service, maker, medium === 'image')}`;
    const f = out.get(key) ?? {maker, medium, names: [], sellers: new Set<string>(), price: null};
    f.names.push(o.serviceDisplayName || o.service);
    f.sellers.add(o.sellerAddress);
    f.price = lowerPrice(f.price, o, medium);
    out.set(key, f);
  }
  return out;
}

type ListPrice = {name: string; usdPerMillion: number};

/** The makers' list prices by family key; batch and free variants are not list prices. */
export function listPrices(res: ListPricesResponse): Map<string, ListPrice> {
  const out = new Map<string, ListPrice>();
  for (const m of res.data) {
    const perToken = Number(m.pricing?.prompt);
    const maker = makerOf(m.id);
    if (!maker || m.id.includes(':') || !(perToken > 0)) continue;
    const key = familyKey(m.id, maker);
    // OpenRouter names read "Maker: Model".
    const name = (m.name ?? m.id).replace(/^[^:]*:\s+/, '').replace(/\s+\d{4,8}$/, '');
    if (!out.has(key)) out.set(key, {name, usdPerMillion: perToken * 1e6});
  }
  return out;
}

const savingOn = (price: number | null, list: ListPrice | undefined): number | null =>
  price !== null && list && price < list.usdPerMillion ? Math.min(MAX_SAVE, Math.max(1, Math.round((1 - price / list.usdPerMillion) * 100))) : null;

/** Most sellers first, then dealt maker by maker, so a lane shows each maker's best before anyone's second. */
function deal(cards: Array<LaneModel & {maker: string}>, medium: Medium): LaneModel[] {
  const byMaker = new Map<string, LaneModel[]>();
  for (const c of [...cards].sort((a, b) => b.providers - a.providers || a.name.localeCompare(b.name))) {
    byMaker.set(c.maker, [...(byMaker.get(c.maker) ?? []), {name: c.name, logo: c.logo, providers: c.providers, price: c.price, save: c.save}]);
  }
  const lane: LaneModel[] = [];
  for (let round = 0; round < PER_MAKER[medium]; round++) {
    for (const models of byMaker.values()) if (models[round] && lane.length < LANE_SIZE[medium]) lane.push(models[round]);
  }
  return lane;
}

/** The lanes of the homepage price board, and the count of models on offer. Text cards need a price; media cards show one once sellers' unit prices reach Antscan. */
export function selectMarket(market: MarketplaceResponse, list: ListPricesResponse): MarketView | null {
  if (!Array.isArray(market.offerings) || !(market.totals?.uniqueServices > 0)) return null;
  const prices = listPrices(list);
  const cards: Record<Medium, Array<LaneModel & {maker: string}>> = {text: [], image: [], video: [], voice: []};
  for (const [key, f] of families(market.offerings)) {
    if (f.medium === 'text' && (f.price === null || f.sellers.size < MIN_TEXT_PROVIDERS)) continue;
    const listed = f.medium === 'text' ? prices.get(key.slice(key.indexOf('/') + 1)) : undefined;
    cards[f.medium].push({
      maker: f.maker.id,
      name: listed?.name ?? pickName(f.names),
      logo: f.maker.logo,
      providers: f.sellers.size,
      price: f.price,
      save: savingOn(f.price, listed),
    });
  }
  const lanes = Object.fromEntries(MEDIA.map((m) => [m, deal(cards[m], m)])) as Record<Medium, LaneModel[]>;
  return lanes.text.length > 0 ? {models: market.totals.uniqueServices, lanes} : null;
}
