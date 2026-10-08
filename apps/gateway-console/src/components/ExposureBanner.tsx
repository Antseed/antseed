import { useState, type MouseEvent } from 'react'
import { Button, IconButton } from '@antseed/ui'
import { useConsole } from '../app/context'
import { exposureHeadline, exposureSummary, readDismissed, rememberDismissed, showExposureBanner } from '../lib/exposure'
import { useStatus } from '../lib/queries'
import { href, navigate } from '../lib/router'
import { Icon } from './icons'
import '../styles/exposure.scss'

/** Plain clicks stay in the app; modified clicks open a new tab as usual. */
function openMigrate(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigate('migrate')
}

/**
 * Tells org owners and admins when the gateway cannot be reached from other
 * machines (no public URL) and points them at the Migrate page. Hidden for
 * everyone else, and for the rest of the session once dismissed.
 */
export function ExposureBanner() {
  const { viewer } = useConsole()
  const status = useStatus()
  const exposure = status.data?.exposure
  const [dismissed, setDismissed] = useState(() => readDismissed(exposure?.mode))
  if (!showExposureBanner(viewer, exposure, dismissed || readDismissed(exposure?.mode)) || !exposure) return null
  return (
    <div className="gc-exposure" role="region" aria-label="Gateway reachability">
      <span className="gc-exposure__icon" aria-hidden="true"><Icon.monitor size={16} /></span>
      <div className="gc-exposure__text">
        <strong>{exposureHeadline(exposure)}.</strong>{' '}
        <span>{exposureSummary(exposure)}</span>
      </div>
      <div className="gc-exposure__actions">
        <Button size="sm" variant="outline" href={href('migrate')} onClick={openMigrate} className="gc-exposure__cta">
          Move to a server <span className="gc-exposure__rec">(recommended)</span>
        </Button>
        <IconButton label="Dismiss for this session" className="gc-exposure__close" onClick={() => { rememberDismissed(exposure.mode); setDismissed(true) }}>
          <Icon.x size={14} />
        </IconButton>
      </div>
    </div>
  )
}
