import { useEffect, useState } from 'react'

const BASE_PATH = '/console'

export interface Location {
  /** Path below the console base, without leading slash: '', 'keys', 'setup'. */
  page: string
  rest: string[]
  query: URLSearchParams
  hash: string
}

export function parseLocation(pathname: string, search = '', hash = ''): Location {
  const below = pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) : pathname
  const segments = below.split('/').filter(Boolean)
  return { page: segments[0] ?? '', rest: segments.slice(1), query: new URLSearchParams(search), hash: hash.replace(/^#/, '') }
}

function current(): Location {
  return parseLocation(window.location.pathname, window.location.search, window.location.hash)
}

const listeners = new Set<() => void>()

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const url = path.startsWith('/') ? `${BASE_PATH}${path}` : `${BASE_PATH}/${path}`
  if (options.replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
  listeners.forEach((listener) => listener())
}

export function useLocation(): Location {
  const [location, setLocation] = useState(current)
  useEffect(() => {
    const update = () => setLocation(current())
    listeners.add(update)
    window.addEventListener('popstate', update)
    return () => {
      listeners.delete(update)
      window.removeEventListener('popstate', update)
    }
  }, [])
  return location
}

export function href(path: string): string {
  return `${BASE_PATH}/${path.replace(/^\//, '')}`
}

/** Click handler for in-app links: plain clicks navigate client-side, modified clicks open normally. */
export function linkHandler(path: string) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(path)
  }
}
