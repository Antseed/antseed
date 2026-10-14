import { useRef, type ReactNode } from 'react'
import { Drawer } from '@antseed/ui'

export interface SidePanelContent {
  title: ReactNode
  subtitle?: ReactNode
  eyebrow?: ReactNode
  body: ReactNode
}

/**
 * A list with a detail drawer sliding in from the right (Models, Providers),
 * the same drawer the request log opens. Escape, a click outside and the
 * close button call `onClose`. `panel` null means closed.
 */
export function SplitView({ list, panel, onClose, closeLabel = 'Close panel' }: {
  list: ReactNode
  panel: SidePanelContent | null
  onClose: () => void
  closeLabel?: string
}) {
  // Keep the last content while the drawer slides out.
  const last = useRef<SidePanelContent | null>(null)
  if (panel) last.current = panel
  const shown = panel ?? last.current
  return (
    <>
      {list}
      <Drawer isOpen={panel !== null} onClose={onClose} closeLabel={closeLabel} className="gc-side-panel"
        title={shown?.title ?? ''} subtitle={shown?.subtitle} eyebrow={shown?.eyebrow}>
        {shown?.body}
      </Drawer>
    </>
  )
}

/** A titled section inside a side panel. */
export function PanelSection({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="gc-panel-section">
      <div className="gc-panel-section__head">
        <h3 className="gc-panel-section__title">{title}</h3>
        {actions && <div className="gc-panel-section__actions">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** A compact row in a side panel's list (a provider of a model, a model of a provider). */
export function PanelRow({ title, meta, badges, actions, selected }: {
  title: ReactNode
  meta?: ReactNode
  badges?: ReactNode
  actions?: ReactNode
  /** The row the panel's API call is showing. */
  selected?: boolean
}) {
  return (
    <li className={selected ? 'gc-panel-row gc-panel-row--on' : 'gc-panel-row'}>
      <div className="gc-panel-row__main">
        <div className="gc-panel-row__title">{title}</div>
        {meta && <div className="gc-panel-row__meta">{meta}</div>}
        {badges}
      </div>
      {actions && <div className="gc-panel-row__actions">{actions}</div>}
    </li>
  )
}
