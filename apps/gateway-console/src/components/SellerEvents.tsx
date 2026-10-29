import type { SellerEventView } from '../api/types'
import { formatRelative } from '../lib/format'
import type { useSellerEvents } from '../lib/queries'
import { EmptyState, ErrorAlert, LoadingRows } from './ui'
import '../styles/seller.scss'

/** The seller's event journal, newest first (Seller overview and Logs). */
export function SellerEventList({ events, limit }: { events: ReturnType<typeof useSellerEvents>; limit?: number }) {
  if (events.isLoading) return <LoadingRows rows={5} height={22} />
  if (events.error) return <ErrorAlert error={events.error} />
  const rows = events.data?.events ?? []
  if (rows.length === 0) return <EmptyState title="No events yet" body="Events show up here as the seller runs." />
  return <ol className="gc-seller-events">{rows.slice(0, limit).map((event, index) => <EventRow key={`${event.at}-${index}`} event={event} />)}</ol>
}

function EventRow({ event }: { event: SellerEventView }) {
  const flagged = event.severity !== 'info'
  return (
    <li className="gc-seller-event">
      <span className={flagged ? 'gc-attention' : 'gc-seller-event__dot'} aria-label={event.severity} role="img" />
      <div className="gc-seller-event__body">
        <div className="gc-seller-event__title">{event.title}</div>
        {event.detail && <div className="gc-seller-event__detail gc-muted">{event.detail}</div>}
      </div>
      <time className="gc-seller-event__time gc-muted" dateTime={new Date(event.at).toISOString()} title={new Date(event.at).toLocaleString()}>{formatRelative(event.at)}</time>
    </li>
  )
}
