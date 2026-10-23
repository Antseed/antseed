import { useAntsPrice, LANTS_SALES_URL } from '../lib/antsPrice';
import { fmt } from '../lib/format';

const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const usd = (n: number) => (n >= 100 ? `$${fmt(n)}` : `$${n.toFixed(2)}`);

/** "≈ $X at the last lANTS sale": a rough USD value for an ANTS amount. Hidden when there's no sale to go on. */
export function UsdHint({ ants, className = '' }: { ants: number; className?: string }) {
  const price = useAntsPrice().data;
  if (!price || !(ants > 0)) return null;
  const title = `At the last lANTS sale on antseedmarkets: ${usd(price.usd)} for ${fmt(price.ants, 2)} ANTS ($${price.usdPerAnts.toFixed(2)} per ANTS) on ${day(price.at)}. lANTS are locked positions and trade thinly, so this is a rough guide, not a market price for ANTS.`;
  return (
    <a className={`usd-hint ${className}`} href={LANTS_SALES_URL} target="_blank" rel="noopener noreferrer" title={title}>
      ≈ {usd(ants * price.usdPerAnts)} at the last lANTS sale
    </a>
  );
}
