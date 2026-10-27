import { useState, type ReactNode } from 'react'
import { Drawer, IconButton } from '@antseed/ui'
import { isSellerPage, NAV_ITEMS, type PageId } from '../lib/nav'
import { href, linkHandler } from '../lib/router'
import { Brand, SELLER_DOCS_URL, ThemeToggle } from './Shell'
import { Icon } from './icons'


/**
 * The console frame for `antseed seller dashboard`: the same top bar, rail and
 * mobile drawer as the gateway console, with only the Seller pages and no
 * workspace or account menus.
 */
export function SellerShell({ version, page, children }: { version: string; page: PageId; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <>
      <div className="gc-app" data-page={page}>
        <a className="gc-skip" href="#gc-main">Skip to content</a>
        <header className="gc-topbar">
          <div className="gc-topbar__inner">
            <IconButton label="Open menu" className="gc-topbar__menu gc-topbar__icon" onClick={() => setMenuOpen(true)}><Icon.menu size={16} /></IconButton>
            <Brand to="seller" />
            <div className="gc-topbar__spacer" />
            <a className="gc-topbar__link" href={SELLER_DOCS_URL} target="_blank" rel="noreferrer">Docs</a>
            <ThemeToggle />
          </div>
        </header>
        <div className="gc-body">
          <aside className="gc-rail"><SellerNav page={page} /><p className="gc-version">Antseed v{version}</p></aside>
          <main id="gc-main" className="gc-main" tabIndex={-1}>{children}</main>
        </div>
      </div>
      <Drawer isOpen={menuOpen} onClose={() => setMenuOpen(false)} side="left" title={<Brand to={null} />} className="gc-mobile-nav">
        <SellerNav page={page} onNavigate={() => setMenuOpen(false)} />
        <p className="gc-version">Antseed v{version}</p>
      </Drawer>
    </>
  )
}

function SellerNav({ page, onNavigate }: { page: PageId; onNavigate?: () => void }) {
  const items = NAV_ITEMS.filter((item) => isSellerPage(item.id))
  return (
    <nav className="gc-nav" aria-label="Console">
      <div className="gc-nav__group">
        <div className="gc-nav__heading">Selling</div>
        {items.map((item) => {
          const IconFor = Icon[item.id as keyof typeof Icon] ?? Icon.overview
          const open = linkHandler(item.id)
          return (
            <a key={item.id} href={href(item.id)} aria-current={item.id === page ? 'page' : undefined}
              onClick={(event) => { open(event); onNavigate?.() }}
              className={item.id === page ? 'gc-nav__item gc-nav__item--on' : 'gc-nav__item'}>
              <IconFor size={16} />
              <span>{item.id === 'seller-settings' ? 'Settings' : item.id === 'seller-logs' ? 'Logs' : item.label}</span>
            </a>
          )
        })}
      </div>
    </nav>
  )
}
