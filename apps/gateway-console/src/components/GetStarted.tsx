import type { ReactNode } from 'react'
import { Button } from '@antseed/ui'
import { useConsole } from '../app/context'
import { canOpen, isOrgAdmin, type PageId } from '../lib/nav'
import { href, linkHandler, navigate } from '../lib/router'
import { Icon } from './icons'

/**
 * The Overview of a workspace with no traffic yet (like OpenRouter's new
 * workspace): what to do first, empty usage tiles, and a map of the console.
 */

/** One "do this first" row: what is missing, why, and the action. */
function SetupCard({ title, body, action }: { title: string; body: ReactNode; action: ReactNode }) {
  return (
    <div className="gc-setup">
      <div className="gc-setup__text">
        <div className="gc-setup__title">{title}</div>
        <div className="gc-setup__body">{body}</div>
      </div>
      {action}
    </div>
  )
}

const BARS = (
  <svg width="28" height="24" viewBox="0 0 28 24" aria-hidden="true" className="gc-empty-tile__bars">
    <rect x="2" y="12" width="6" height="12" rx="1.5" /><rect x="11" y="6" width="6" height="18" rx="1.5" /><rect x="20" y="0" width="6" height="24" rx="1.5" />
  </svg>
)

const SECTIONS: Array<{ id: PageId; title: string; body: string }> = [
  { id: 'keys', title: 'API keys', body: 'Create keys for apps and people, with budgets and their own routing.' },
  { id: 'chat', title: 'Chat', body: 'Try any model on the network and see which seller answers.' },
  { id: 'wallet', title: 'Wallet & Funding', body: 'Fund the workspace wallet and authorize who can withdraw.' },
  { id: 'routing', title: 'Routing', body: 'Choose which sellers may serve, price caps, TEE only, fallbacks.' },
  { id: 'providers', title: 'Providers', body: 'Every provider this gateway sees, with prices, trust and latency.' },
  { id: 'models', title: 'Models', body: 'Every model on the network, its providers and a ready-to-run API call.' },
  { id: 'presets', title: 'Presets', body: 'Save a model, system prompt and parameters as @preset/<name>.' },
  { id: 'members', title: 'Members', body: 'Invite people and choose what each of them may do.' },
  { id: 'activity', title: 'Activity', body: 'Spend, requests and tokens by model, key and member.' },
  { id: 'settings', title: 'Settings', body: 'Buyer settings every policy starts from, observability and sign-in.' },
]

export function GetStarted({ hasKeys, fundsKnown, funded }: { hasKeys: boolean; fundsKnown: boolean; funded: boolean }) {
  const { workspace, viewer } = useConsole()
  const sections = SECTIONS.filter((section) => canOpen(section.id, viewer))
  return (
    <>
      {!hasKeys && (
        <SetupCard title="No API keys yet" body="Create your first API key to start using this workspace from your apps."
          action={<Button variant="brand" leadingIcon={<Icon.plus size={14} />} onClick={() => navigate('keys?new=1')}>Create API key</Button>} />
      )}
      {fundsKnown && !funded && canOpen('wallet', viewer) && (
        <SetupCard title="No funds yet" body={<>Requests to paid sellers are paid in USDC from the {workspace.name} wallet. Free sellers work without funds.</>}
          action={<Button variant="outline" onClick={() => navigate('wallet?fund=1')}>Add funds</Button>} />
      )}
      {isOrgAdmin(viewer) && (
        <SetupCard title="Review buyer settings" body="Price caps, minimum trust (60 by default) and verification apply to every key."
          action={<Button variant="ghost" onClick={() => navigate('settings')}>Open settings</Button>} />
      )}

      <div className="gc-section-head">
        <h2>This week's usage</h2>
        <a className="gc-link" href={href('activity')} onClick={linkHandler('activity')}>View activity <Icon.right size={13} /></a>
      </div>
      <div className="gc-grid gc-grid--3">
        {['No spend this week', 'No requests this week', 'No tokens this week'].map((label) => (
          <div key={label} className="gc-empty-tile">{BARS}<span>{label}</span></div>
        ))}
      </div>

      <div className="gc-grid gc-grid--3">
        {sections.map((section) => {
          const IconFor = Icon[section.id as keyof typeof Icon] ?? Icon.overview
          return (
            <a key={section.id} className="gc-section-card" href={href(section.id)} onClick={linkHandler(section.id)}>
              <span className="gc-section-card__icon"><IconFor size={16} /></span>
              <span className="gc-section-card__text">
                <span className="gc-section-card__title">{section.title}</span>
                <span className="gc-section-card__body">{section.body}</span>
              </span>
              <Icon.right size={14} className="gc-section-card__chevron" />
            </a>
          )
        })}
      </div>
    </>
  )
}
