import { fmt } from '../lib/format';
import type { Network } from '../lib/model';
import { Link } from '../lib/router';
import { LINKS } from '../lib/links';

const FAQ: [string, string][] = [
  ['Does free usage earn points?', "No. Points come from paid usage only, at the provider's boost. Free models earn no points."],
  ['Do I need to stake to earn points?', 'No. Paid usage with a boosted provider earns points on its own. Staking is optional and earns separate rewards.'],
  ['Do I need crypto to start?', 'No. In the AI VPN you can add funds by card where it’s available, or send USDC on Base.'],
  ['When do my points show up?', 'Usually around 10 minutes after your last request, once the provider settles payment. Long sessions settle in parts as you go.'],
  ['Which week do my points count in?', "The week they settle in. If you use AI just before Thursday 09:54 UTC, those points can land in the next week. You don't lose them."],
  ['Can my points go down?', "No. Points you've earned stay as they are. Only what each point is worth moves until Thursday, as more people spend."],
  ['Is there a limit?', "Yes. One buyer or one provider can claim up to 5% of a week's rewards. The 5% cap doesn't apply to staking rewards."],
  ['Why does a provider show 0×?', 'Nobody has staked behind it. Paid usage there earns no points. Check the boost before you spend.'],
  ['What about fake usage?', 'Usage proven to be fake (wash trading) earns no points. It’s checked against what happened on Base.'],
  ['Is this a new points system?', 'These points already exist onchain. Antseed Points brings them into one place. What you get in ANTS is exactly what the contracts pay.'],
  ['How do I claim?', 'Your ANTS go to the reward wallet set in the AI VPN or console, under Rewards. Connect that wallet under Your points to claim, or stake them straight into a provider.'],
];

/** How points work, for people who want the detail: the boost, the staker pot and common questions. */
export function HowPoints({ net }: { net: Network | undefined }) {
  return (
    <section id="how" className="ag-mint" aria-labelledby="how-h">
      <div className="wrap stack" style={{ gap: 36 }}>
        <div className="ag-head" style={{ marginBottom: 0 }}>
          <h2 id="how-h" className="disp" style={{ color: 'var(--ink)' }}>How points work</h2>
          <p style={{ color: 'var(--ink)' }}>Your paid usage earns points based on the provider’s boost. Each Thursday, your share of the week’s points determines your ANTS reward. Staking earns separate rewards.</p>
        </div>
        <div className="how-g how-g2">
          <section className="game-card" aria-labelledby="boost-h">
            <div className="game-head"><h3 id="boost-h" className="disp" style={{ color: '#fff' }}>The boost</h3><p>How your dollars become points.</p></div>
            <div className="calc-body">
              <div className="num how-big">$1 × boost = points</div>
              <p className="how-p">Every provider has a boost. It comes from the ANTS people have staked behind it, and for how long. 10,000 ANTS locked for two years makes 1.0×.</p>
              <p className="how-p">Spend $1 with a 20× provider and you get 20 points. A provider with nothing staked is 0×: paid usage there earns no points.</p>
              <p className="how-p">Every Thursday the {net ? fmt(net.pots.buyer) : '250,000'} ANTS pot is split by points. Nobody can take more than 5% of it. Providers earn points the same way, from a pot of their own.</p>
            </div>
          </section>
          <section className="game-card" aria-labelledby="stake-h2">
            <div className="game-head"><h3 id="stake-h2" className="disp" style={{ color: '#fff' }}>The staker pot</h3><p>What you get for backing a provider.</p></div>
            <div className="calc-body">
              <div className="num how-big">{net ? fmt(net.pots.staker) : '…'} ANTS <small>a week for stakers</small></div>
              <p className="how-p">Stake ANTS behind a provider and you raise its boost for everyone who uses it. You also get a share of this pot.</p>
              <p className="how-p">Busier providers and longer locks get you a bigger share. Leave before your lock ends and 5–50% of the stake is burned. There's no 5% limit here.</p>
              <Link className="btn btn-ink btn-sm" href="#stake" style={{ justifySelf: 'start' }}>Stake</Link>
            </div>
          </section>
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <h3 className="disp" style={{ fontSize: 28, margin: 0 }}>Questions</h3>
          <div className="faq">
            {FAQ.map(([q, a], i) => (
              <details key={q} open={i === 0}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
        <div className="how-links">
          <a href={LINKS.rules} target="_blank" rel="noopener noreferrer">Read the full reward rules ↗</a>
          <a href={LINKS.tokenomics} target="_blank" rel="noopener noreferrer">ANTS tokenomics ↗</a>
        </div>
      </div>
    </section>
  );
}
