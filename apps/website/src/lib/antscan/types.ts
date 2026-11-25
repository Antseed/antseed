/** The site's view of the network, as the hooks return it and as the build snapshot stores it. */

export type Medium = 'text' | 'image' | 'video' | 'voice';

export type NetworkTotals = {
  /** Buyers that ever opened a channel. */
  users: number;
  /** Registered sellers. */
  providers: number;
  /** Requests served, paid and free. */
  requests: number;
  /** Tokens served, paid and free, input and output. */
  tokens: number;
  /** USDC settled to sellers. */
  settledUsd: number;
};

export type LaneModel = {
  name: string;
  /** Path under /site/assets/home/icons/; `labs-color/` marks keep their colours, `labs/` ones take the text colour. */
  logo: string;
  /** Sellers offering it. */
  providers: number;
  /** Lowest price among reputable sellers, in USD per unit of its medium (`UNIT_LABEL`); null when no seller publishes one. */
  price: number | null;
  /** Text: the saving on the maker's list price, in percent. */
  save: number | null;
};

export type MarketView = {
  /** Distinct services on offer. */
  models: number;
  lanes: Record<Medium, LaneModel[]>;
};

export type AntsToken = {
  /** Minted ANTS (totalSupply), in whole tokens. */
  supply: number;
  /** ANTS held by 0x…dEaD, in whole tokens. */
  burned: number;
  epoch: number;
  /** Unix seconds. */
  epochEndsAt: number;
  epochSeconds: number;
};

export type AntscanResources = {
  totals: NetworkTotals;
  market: MarketView;
  ants: AntsToken;
};

export type ResourceKey = keyof AntscanResources;

export type AntscanSnapshot = AntscanResources & {
  /** ISO time the build read it. */
  readAt: string;
};
