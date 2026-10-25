import type { ReactNode } from 'react'
import { isSellerPage, NAV_ITEMS, type PageId } from '../lib/nav'
import { href, linkHandler } from '../lib/router'
import { Brand, ThemeToggle } from './Shell'
import { Icon } from './icons'

const DOCS_URL = 'https://antseed.com/docs'

/**
 * The console frame for `antseed seller dashboard`: the same top bar and rail
 * as the gateway console, with only the Seller pages and no workspace or account menus.
 */
export function SellerShell({ version, page, children }: { version: string; page: PageId; children: ReactNode }) {
  const items = NAV_ITEMS.filter((item) => isSellerPage(item.id))
  return (
    <div className="gc-app" data-page={page}>
      <a className="gc-skip" href="#gc-main">Skip to content</a>
      <header className="gc-topbar">
        <div className="gc-topbar__inner">
          <Brand to="seller" />
          <div className="gc-topbar__spacer" />
          <a className="gc-topbar__link" href={DOCS_URL} target="_blank" rel="noreferrer">Docs</a>
          <ThemeToggle />
        </div>
      </header>
      <div className="gc-body">
        <aside className="gc-rail">
          <nav className="gc-nav" aria-label="Console">
            <div className="gc-nav__group">
              <div className="gc-nav__heading">Selling</div>
              {items.map((item) => {
                const IconFor = Icon[item.id as keyof typeof Icon] ?? Icon.overview
                return (
                  <a key={item.id} href={href(item.id)} aria-current={item.id === page ? 'page' : undefined} onClick={linkHandler(item.id)}
                    className={item.id === page ? 'gc-nav__item gc-nav__item--on' : 'gc-nav__item'}>
                    <IconFor size={16} />
                    <span>{item.id === 'seller-settings' ? 'Settings' : item.id === 'seller-logs' ? 'Logs' : item.label}</span>
                  </a>
                )
              })}
            </div>
          </nav>
          <p className="gc-version">Antseed v{version}</p>
        </aside>
        <main id="gc-main" className="gc-main" tabIndex={-1}>{children}</main>
      </div>
    </div>
  )
}
