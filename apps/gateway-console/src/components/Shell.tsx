import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Drawer, IconButton, LoadingRows, Logo, LogoMark } from '@antseed/ui'
import { api } from '../api'
import { useConsole } from '../app/context'
import { useTheme, type ThemeChoice } from '../app/theme'
import { ROLE_LABELS, visibleNav, type PageId } from '../lib/nav'
import { href, linkHandler, navigate, useLocation } from '../lib/router'
import { useWalletAttention } from '../lib/attention'
import { AccountModal } from './AccountModal'
import { AntDots } from './AntDots'
import { ExposureBanner } from './ExposureBanner'
import { Icon } from './icons'

const DOCS_URL = 'https://antseed.com/docs/guides/gateway-console'

/** `/console/migrate`: reached from the reachability banner, not the nav. */
const MigratePage = lazy(() => import('../pages/Migrate'))

/** The Antseed logo linking home; the mark alone on narrow screens. */
export function Brand({ to = 'overview', tagged, size = 26 }: { to?: string | null; tagged?: boolean; size?: number }) {
  const content = (
    <>
      <Logo height={size} className="gc-brand__full" />
      <LogoMark size={26} className="gc-brand__mark" />
      <span className="gc-brand__tag">Console</span>
    </>
  )
  const className = tagged ? 'gc-brand gc-brand--tagged' : 'gc-brand'
  if (to === null) return <span className={className}>{content}</span>
  return <a className={className} href={href(to)} onClick={linkHandler(to)} aria-label="Antseed console home">{content}</a>
}

const NO_OPERATOR = 'No authorized wallet: nobody can withdraw funds or claim ANTS rewards'

function WorkspaceSwitcher() {
  const { me, workspace, setWorkspaceId } = useConsole()
  const { missingOperator, currentMissingOperator } = useWalletAttention()
  const marker = currentMissingOperator && <span className="gc-attention" role="img" aria-label={NO_OPERATOR} title={NO_OPERATOR} />
  if (me.workspaces.length <= 1) {
    return <span className="gc-ws" title="Workspace"><Icon.workspaces size={14} /><span className="gc-ws__name">{workspace.name}</span>{marker}</span>
  }
  return (
    <label className="gc-ws gc-ws--select">
      <Icon.workspaces size={14} />
      <select className="gc-ws__select" value={workspace.id} onChange={(event) => setWorkspaceId(event.target.value)} aria-label="Switch workspace">
        {me.workspaces.map(({ workspace: ws, role }) => (
          <option key={ws.id} value={ws.id}>{ws.name}{role === 'admin' ? ' (admin)' : ''}{ws.id !== workspace.id && missingOperator.has(ws.id) ? ' · no authorized wallet' : ''}</option>
        ))}
      </select>
      {marker}
      <Icon.down size={14} className="gc-ws__chevron" />
    </label>
  )
}

/** Why a nav item has a dot, or null. */
function navAttention(id: PageId, attention: ReturnType<typeof useWalletAttention>): string | null {
  if (id !== 'wallet') return null
  if (attention.currentMissingOperator) return NO_OPERATOR
  if (attention.withdrawable.count > 0) return `${attention.withdrawable.count} channel${attention.withdrawable.count === 1 ? '' : 's'} ready to withdraw`
  return null
}

function Nav({ current, onNavigate }: { current: PageId | null; onNavigate?: () => void }) {
  const { viewer } = useConsole()
  const attention = useWalletAttention()
  const items = visibleNav(viewer)
  const groups = [...new Set(items.map((item) => item.group))]
  return (
    <nav className="gc-nav" aria-label="Console">
      {groups.map((group) => (
        <div key={group} className="gc-nav__group">
          <div className="gc-nav__heading">{group}</div>
          {items.filter((item) => item.group === group).map((item) => {
            const IconFor = Icon[item.id as keyof typeof Icon] ?? Icon.overview
            return (
              <a key={item.id} href={href(item.id)} aria-current={item.id === current ? 'page' : undefined}
                className={item.id === current ? 'gc-nav__item gc-nav__item--on' : 'gc-nav__item'}
                onClick={(event) => { linkHandler(item.id)(event); onNavigate?.() }}>
                <IconFor size={16} />
                <span>{item.label}</span>
                {(() => {
                  const reason = navAttention(item.id, attention)
                  return reason && <span className="gc-attention gc-nav__attention" role="img" aria-label={reason} title={reason} />
                })()}
              </a>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

const THEME_NAMES: Record<ThemeChoice, string> = { system: 'System', dark: 'Dark', light: 'Light' }
const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { system: 'dark', dark: 'light', light: 'system' }
const THEME_ICONS: Record<ThemeChoice, typeof Icon.monitor> = { system: Icon.monitor, dark: Icon.moon, light: Icon.sun }

/** Cycles System → Dark → Light; the name says the current and the next choice. */
export function ThemeToggle() {
  const [choice, setChoice] = useTheme()
  const next = NEXT_THEME[choice]
  const ThemeIcon = THEME_ICONS[choice]
  return (
    <IconButton className="gc-topbar__icon" label={`Color theme: ${THEME_NAMES[choice]}. Switch to ${THEME_NAMES[next]}.`} onClick={() => setChoice(next)}>
      <ThemeIcon size={16} />
    </IconButton>
  )
}

/** Signs out, drops every cached response and returns to the sign-in page. */
export function useSignOut() {
  const queryClient = useQueryClient()
  return async () => {
    try { await api.auth.logout() } finally {
      queryClient.clear()
      navigate('login', { replace: true })
    }
  }
}

/** First and last initials ("Dana Owner" → "DO"); "?" for a blank name. */
function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? '?'
  const last = parts.length > 1 ? parts[parts.length - 1]![0] : ''
  return (first + last).toUpperCase()
}

/** Avatar button with a small menu: who is signed in, account settings, sign out. */
function AccountMenu({ onAccount, onSignOut }: { onAccount: () => void; onSignOut: () => void }) {
  const { me } = useConsole()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [open])
  const pick = (action: () => void) => () => { setOpen(false); action() }
  const role = ROLE_LABELS[me.member.orgRole]
  const meta = me.member.email ? `${me.member.email} · ${role}` : role
  return (
    <div className="gc-account" ref={root}>
      <button ref={trigger} type="button" className="gc-user" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Your account: ${me.member.label}`} onClick={() => setOpen((value) => !value)}>
        <span className="gc-avatar" aria-hidden="true">{initials(me.member.label)}</span>
      </button>
      {open && (
        <div className="gc-account__menu" role="menu" aria-label="Account">
          <div className="gc-account__who">
            <div className="gc-account__name">{me.member.label}</div>
            <div className="gc-account__meta">{meta}</div>
          </div>
          <button type="button" role="menuitem" className="gc-account__item" onClick={pick(onAccount)}><Icon.shield size={15} />Account and sign-in</button>
          <a role="menuitem" className="gc-account__item" href={DOCS_URL} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}><Icon.external size={15} />Documentation</a>
          <div className="gc-account__sep" />
          <button type="button" role="menuitem" className="gc-account__item" onClick={pick(onSignOut)}><Icon.logout size={15} />Sign out</button>
        </div>
      )}
    </div>
  )
}

export function Shell({ page, children }: { page: PageId; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)
  // `?account=1` opens the account dialog, e.g. after a failed provider link sends the member back.
  const [accountOpen, setAccountOpen] = useState(() => new URLSearchParams(window.location.search).get('account') === '1')
  const logout = useSignOut()
  const migrating = useLocation().page === 'migrate'
  const current = migrating ? null : page

  return (
    <>
      <div className="gc-app">
        <a className="gc-skip" href="#gc-main">Skip to content</a>
        <header className="gc-topbar">
          <div className="gc-topbar__inner">
            <IconButton label="Open menu" className="gc-topbar__menu gc-topbar__icon" onClick={() => setMenuOpen(true)}><Icon.menu size={16} /></IconButton>
            <Brand />
            <span className="gc-topbar__sep" aria-hidden="true">/</span>
            <WorkspaceSwitcher />
            <div className="gc-topbar__spacer" />
            <a className="gc-topbar__link" href={DOCS_URL} target="_blank" rel="noreferrer">Docs</a>
            <ThemeToggle />
            <AccountMenu onAccount={() => setAccountOpen(true)} onSignOut={() => void logout()} />
          </div>
        </header>
        <div className="gc-body">
          <aside className="gc-rail"><Nav current={current} /><AntDots /></aside>
          <main id="gc-main" className="gc-main" tabIndex={-1}>
            {migrating ? <Suspense fallback={<LoadingRows rows={6} />}><MigratePage /></Suspense> : <><ExposureBanner />{children}</>}
          </main>
        </div>
      </div>
      <Drawer isOpen={menuOpen} onClose={() => setMenuOpen(false)} side="left" title={<Brand to={null} />} className="gc-mobile-nav">
        <Nav current={current} onNavigate={() => setMenuOpen(false)} />
      </Drawer>
      <AccountModal isOpen={accountOpen} onClose={() => setAccountOpen(false)} />
    </>
  )
}
