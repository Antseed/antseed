import type { ViewName } from '../../ui/types';

/** One banner under Home's usage card, picked by how long the user has had the app. */
export type HomePromo = {
  id: string;
  /** Shown from this many days after the first prompt. */
  fromDay: number;
  /** Shown ahead of every other banner while it applies. */
  urgent?: boolean;
  /** Closing it hides it for the day only. */
  daily?: boolean;
  eyebrow: string;
  title: string;
  text: string;
  cta: string;
  target: ViewName;
  applies: (facts: PromoFacts) => boolean;
};

export type PromoFacts = {
  day: number;
  funded: boolean;
  lowBalance: boolean;
  privateMode: boolean;
  rewardsLive: boolean;
  dismissed: string[];
};

export const LOW_BALANCE_USD = 1;
const DAY_MS = 86_400_000;

export const HOME_PROMOS: HomePromo[] = [
  {
    id: 'top-up',
    fromDay: 0,
    urgent: true,
    daily: true,
    eyebrow: 'Balance',
    title: 'Your balance is running low',
    text: 'Top up to keep paid models running in chat, your agents and your apps.',
    cta: 'Add funds',
    target: 'deposit',
    applies: (facts) => facts.lowBalance,
  },
  {
    id: 'telegram',
    fromDay: 2,
    eyebrow: 'On your phone',
    title: 'Chat with Antseed from Telegram',
    text: 'Your own Telegram bot talks to Antseed on this computer, with the same models and balance.',
    cta: 'Set up Telegram',
    target: 'tools',
    applies: () => true,
  },
  {
    id: 'private',
    fromDay: 5,
    eyebrow: 'Privacy',
    title: 'Try Private mode',
    text: 'Providers can’t read your chats. Switch to Private at the top of the chat.',
    cta: 'Try Private',
    target: 'chat',
    applies: (facts) => !facts.privateMode,
  },
  {
    id: 'rewards',
    fromDay: 7,
    eyebrow: 'Rewards',
    title: 'You earn ANTS on what you spend',
    text: 'See what you have earned so far and how rewards work.',
    cta: 'See rewards',
    target: 'rewards',
    applies: (facts) => facts.rewardsLive && facts.funded,
  },
];

/** Whole days since the first prompt; 0 before it. */
export function daysSince(firstPromptAt: number | null, now = Date.now()): number {
  return firstPromptAt === null ? 0 : Math.max(0, Math.floor((now - firstPromptAt) / DAY_MS));
}

/** The id a close is stored under: daily banners come back the next day. */
export function promoDismissKey(promo: HomePromo, day: number): string {
  return promo.daily ? `${promo.id}@${day}` : promo.id;
}

/** An urgent banner first, otherwise the newest one the user has reached. */
export function pickHomePromo(facts: PromoFacts, promos: HomePromo[] = HOME_PROMOS): HomePromo | null {
  const open = promos.filter((promo) => facts.day >= promo.fromDay
    && !facts.dismissed.includes(promoDismissKey(promo, facts.day))
    && promo.applies(facts));
  return open.find((promo) => promo.urgent)
    ?? open.reduce<HomePromo | null>((latest, promo) => (!latest || promo.fromDay > latest.fromDay ? promo : latest), null);
}
