import { LINKS } from '../lib/links';
import { Link } from '../lib/router';
import { DownloadVpnButton } from './DownloadVpn';

/** The closing section: how to start, in three steps, plus a prompt to paste into an agent. */
export function StartSteps() {
  return (
    <section id="start" className="ag-dark" aria-labelledby="cta-h">
      <div className="wrap stack" style={{ gap: 32, paddingBlock: 88 }}>
        <div className="ag-head" style={{ marginBottom: 0 }}>
          <h2 id="cta-h" className="disp" style={{ color: '#fff' }}>Start earning this week</h2>
          <p className="muted-d">Start earning with qualifying paid usage through a boosted provider. Points appear after payment settles.</p>
        </div>
        <ol className="start-steps">
          <li>
            <b>Download the AI VPN</b>
            <span>The Antseed desktop app, for Mac, Windows and Linux.</span>
            <DownloadVpnButton className="btn btn-green btn-sm" label="Download" />
          </li>
          <li>
            <b>Add funds</b>
            <span>Pay by card where it’s available, or send USDC on Base. One credit is one dollar.</span>
            <a className="btn btn-line-d btn-sm" href={LINKS.desktopDocs} target="_blank" rel="noopener noreferrer">How to add funds</a>
          </li>
          <li>
            <b>Use AI with a boosted provider</b>
            <span>Chat as you normally would. A higher boost earns you more points for every dollar.</span>
            <Link className="btn btn-line-d btn-sm" href="#providers">See providers</Link>
          </li>
        </ol>
      </div>
    </section>
  );
}
