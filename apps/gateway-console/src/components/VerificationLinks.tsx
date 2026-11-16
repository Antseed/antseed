import type { PeerVerificationLink } from '../api/types'

/**
 * A provider's verified identity: its domain and GitHub, as small external
 * links. The gateway sends only claims the buyer verified, already
 * sanitised; nothing renders when there are none.
 */
export function VerificationLinks({ links }: { links: readonly PeerVerificationLink[] | undefined }) {
  if (!links?.length) return null
  return (
    <span className="gc-verified-links">
      {links.map((link) => (
        <a key={`${link.kind}:${link.href}`} className="gc-verified-link" href={link.href} target="_blank" rel="noopener noreferrer"
          title={link.kind === 'domain' ? `Verified domain: ${link.label}` : `Verified GitHub: ${link.label}`}
          onClick={(event) => event.stopPropagation()}>
          {link.label}
        </a>
      ))}
    </span>
  )
}
