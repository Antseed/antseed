import { useId, useState } from 'react'
import { Icon } from './icons'

const REPUTATION_DOCS = 'https://antseed.com/docs/reputation'

/**
 * A small ⓘ with a tooltip: shown on hover or keyboard focus, toggled by a
 * tap on touch screens. It floats over the page and never moves the layout.
 */
export function InfoTip({ label, children, align = 'start' }: {
  label: string
  children: React.ReactNode
  /** `end` opens the bubble leftward, for tips near the right edge (side panels). */
  align?: 'start' | 'end'
}) {
  const [pinned, setPinned] = useState(false)
  const id = useId()
  return (
    <span className={['gc-tip', pinned && 'gc-tip--open', align === 'end' && 'gc-tip--end'].filter(Boolean).join(' ')} onMouseLeave={() => setPinned(false)}>
      <button type="button" className="gc-tip__button" aria-label={label} aria-describedby={id}
        onClick={() => setPinned((open) => !open)} onBlur={() => setPinned(false)}>
        <Icon.info size={14} />
      </button>
      <span role="tooltip" id={id} className="gc-tip__bubble">{children}</span>
    </span>
  )
}

/** What the trust score is made of, in a few lines. */
export function TrustTip() {
  return (
    <InfoTip label="What is the trust score?">
      <span className="gc-tip__title">Trust score, 0 to 100</span>
      Your buyer works it out for each seller from records it can check: service history (up to 50), usage last week (20),
      staked ANTS (10) and a verified GitHub or domain (20), plus 5 for a free model. Proven wash traders score 0.{' '}
      <a href={REPUTATION_DOCS} target="_blank" rel="noreferrer">How it works</a>
    </InfoTip>
  )
}
