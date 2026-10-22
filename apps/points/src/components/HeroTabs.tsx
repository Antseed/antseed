import { useState } from 'react';
import { LINKS } from '../lib/links';
import { AddressLookup } from '../pages/Home';

type Tab = 'lookup' | 'agent';
/** Agents follow links without the scheme; dropping it keeps the prompt short enough to read at a glance. */
const bare = (url: string) => url.replace(/^https?:\/\//, '');

/**
 * What an agent should do: set Antseed up (the public join-buyer skill), then route to the
 * highest-boost providers that serve the model (skills/antseed-rewards in the repo).
 */
export const AGENT_PROMPT = `Set up Antseed with ${bare(LINKS.setupSkill)}, then use ${bare(LINKS.rewardsSkill)} to route my requests to the highest-boost providers.`;

/** The hero's card: look up an account's points, or hand an agent the setup prompt. */
export function HeroTabs() {
  const [tab, setTab] = useState<Tab>('lookup');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(AGENT_PROMPT);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard access: select the text so it can be copied by hand.
      const el = document.getElementById('agent-prompt');
      if (el) window.getSelection()?.selectAllChildren(el);
    }
  };
  return (
    <div className="htabs">
      <div className="htabs-bar" role="tablist" aria-label="Get started">
        <button type="button" role="tab" aria-selected={tab === 'lookup'} onClick={() => setTab('lookup')}>See your points</button>
        <button type="button" role="tab" aria-selected={tab === 'agent'} onClick={() => setTab('agent')}>Connect an agent</button>
      </div>
      {tab === 'lookup' ? (
        <div className="htabs-body" role="tabpanel">
          <AddressLookup dark cta="Look up" />
          <span className="htabs-note">In the AI VPN, open Rewards → See your points to view this account automatically.</span>
        </div>
      ) : (
        <div className="htabs-body" role="tabpanel">
          <div className="htabs-prompt">
            <span id="agent-prompt">{AGENT_PROMPT}</span>
            <button type="button" className="htabs-copy" onClick={copy} aria-label="Copy the prompt">{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <div className="htabs-foot">
            <span className="htabs-note">Paste it into Claude Code, Codex or a compatible coding agent.</span>
            <a className="htabs-cta" href={LINKS.install} target="_blank" rel="noopener noreferrer">Read the install guide →</a>
          </div>
        </div>
      )}
    </div>
  );
}
