import { avatarColor } from '../lib/format';
import type { Provider } from '../lib/model';

export function Avatar({ p }: { p: Pick<Provider, 'name' | 'seller'> }) {
  const letter = (p.name.replace(/[^A-Za-z0-9]/g, '') || '?')[0]!.toUpperCase();
  return (
    <span className="avatar" style={{ background: avatarColor(p.seller) }} aria-hidden="true">
      {letter}
    </span>
  );
}

export function BoostBadge({ p }: { p: Provider }) {
  if (p.boost < 0.01) return <span className="badge zero">0× earns nothing</span>;
  if (p.stakeAnts > 1000 && p.lockStrength < 0.1) return <span className="badge seed">Lock ending</span>;
  return null;
}
