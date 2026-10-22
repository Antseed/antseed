import { useViewedAddress } from '../lib/address';
import { fmt } from '../lib/format';
import { useAccount, type Network } from '../lib/model';
import { MAX_LOCK_EPOCHS } from '../lib/points';

// The lANTS marketplaces listed on antseed.com/ecosystem (apps/website/src/pages/ecosystem.tsx).
const MARKETS = [
  {
    name: 'antseedmarkets',
    href: 'https://antseedmarkets.com',
    tag: '0% marketplace fee',
    body: "List or buy lANTS with no marketplace fee. Built on OpenSea's Seaport, and open source.",
  },
  {
    name: 'lANTS Market',
    href: 'https://lants.eth.limo',
    tag: 'Priced in USDC',
    body: 'Compare every position by amount, lock, provider, exit penalty and pending reward, then list or buy it in USDC.',
  },
];

/** Every stake is an lANTS NFT: what it records, why it matters, and where people trade them. */
export function LantsSection({ net }: { net: Network | undefined }) {
  const { address } = useViewedAddress();
  const account = useAccount(address, net);
  // Show the visitor's own position on the card when they have one; otherwise an example.
  const mine = account.data?.stakes[0];
  const card = mine
    ? { id: `#${mine.id}`, provider: mine.provider, ants: mine.amountAnts, lock: mine.maxLocked ? 'Max lock' : `${Math.max(0, mine.endEpoch - (net?.epoch ?? 0))} weeks left` }
    : { id: 'Example', provider: 'GesundAI', ants: 10_000, lock: `Max lock · ${MAX_LOCK_EPOCHS} weeks` };
  const count = account.data?.stakes.length ?? 0;

  return (
    <section id="lants" className="lants" aria-labelledby="lants-h">
      <div className="wrap lants-g">
        <div className="stack" style={{ gap: 22 }}>
          <h2 id="lants-h" className="disp" style={{ color: 'var(--ink)' }}>Your stake comes with an lANTS&nbsp;NFT</h2>
          <p className="lants-lead">This NFT represents your staking position: the provider you back, the amount locked, and the lock terms.</p>
          <ul className="lants-why">
            <li><b>You can list your position for sale.</b> If someone buys it, they take over the stake and its lock terms.</li>
            <li><b>Or buy one.</b> A listed position lets you back a provider with its lock terms already set.</li>
          </ul>
          <div className="lants-markets">
            {MARKETS.map((m) => (
              <a key={m.name} className="lants-mk" href={m.href} target="_blank" rel="noopener noreferrer">
                <span className="lants-mk-top"><b>{m.name}</b><em>{m.tag}</em></span>
                <span className="lants-mk-body">{m.body}</span>
                <span className="lants-mk-go">Open ↗</span>
              </a>
            ))}
          </div>
          {count > 0 && <p className="note" style={{ margin: 0 }}>This wallet holds {count} lANTS position{count === 1 ? '' : 's'}. You'll see them under Your points.</p>}
        </div>

        <div className="lants-nft" aria-label={mine ? 'Your lANTS position' : 'Example lANTS position'}>
          <div className="lants-nft-top"><span>lANTS</span><span>{card.id}</span></div>
          <div className="lants-nft-amt num">{fmt(card.ants)}<small> ANTS</small></div>
          <dl>
            <div><dt>Backing</dt><dd>{card.provider}</dd></div>
            <div><dt>Lock</dt><dd>{card.lock}</dd></div>
            <div><dt>Network</dt><dd>Base</dd></div>
          </dl>
          <span className="lants-nft-foot">Locked ANTS · Antseed seller pools</span>
        </div>
      </div>
    </section>
  );
}
