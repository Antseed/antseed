import { useId, useState } from 'react'
import { Button, IconButton } from '@antseed/ui'
import type { Peer } from '../api/types'
import { shortId } from '../lib/format'
import { samePeerId } from '../lib/peer-id'
import { moveItem } from '../lib/policy'
import { Icon } from './icons'

export function peerName(peers: readonly Peer[] | undefined, peerId: string): string {
  const peer = peers?.find((entry) => samePeerId(entry.peerId, peerId))
  return peer?.displayName ?? shortId(peerId, 8, 4)
}

/**
 * Pick sellers by name or paste a peer id. `ordered` shows up/down controls
 * for fallback chains.
 */
export function PeerPicker({ value, onChange, peers, label, ordered, placeholder = 'Search sellers or paste a peer id' }: {
  value: string[]; onChange: (value: string[]) => void; peers?: readonly Peer[]; label: string; ordered?: boolean; placeholder?: string
}) {
  const [text, setText] = useState('')
  const listId = useId()
  const inputId = useId()

  function add() {
    const raw = text.trim()
    if (!raw) return
    const match = peers?.find((peer) => peer.displayName?.toLowerCase() === raw.toLowerCase() || peer.peerId.toLowerCase() === raw.toLowerCase())
    const peerId = match?.peerId ?? raw
    if (!value.some((entry) => entry.toLowerCase() === peerId.toLowerCase())) onChange([...value, peerId])
    setText('')
  }

  return (
    <div className="gc-picker">
      <label className="as-field__label" htmlFor={inputId}>{label}</label>
      {value.length > 0 && (
        <ol className={ordered ? 'gc-chips gc-chips--ordered' : 'gc-chips'}>
          {value.map((peerId, index) => (
            <li key={peerId} className="gc-chip">
              {ordered && <span className="gc-chip__index">{index + 1}</span>}
              <span className="gc-chip__label" title={peerId}>{peerName(peers, peerId)}</span>
              {ordered && (
                <>
                  <IconButton label={`Move ${peerName(peers, peerId)} up`} size="sm" disabled={index === 0}
                    onClick={() => onChange(moveItem(value, index, -1))}><Icon.up size={12} /></IconButton>
                  <IconButton label={`Move ${peerName(peers, peerId)} down`} size="sm" disabled={index === value.length - 1}
                    onClick={() => onChange(moveItem(value, index, 1))}><Icon.down size={12} /></IconButton>
                </>
              )}
              <IconButton label={`Remove ${peerName(peers, peerId)}`} size="sm"
                onClick={() => onChange(value.filter((entry) => entry !== peerId))}><Icon.x size={12} /></IconButton>
            </li>
          ))}
        </ol>
      )}
      <div className="gc-inline">
        <input id={inputId} className="as-field__input gc-picker__input" list={listId} value={text} placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }} />
        <datalist id={listId}>
          {peers?.map((peer) => <option key={peer.peerId} value={peer.peerId}>{peer.displayName ?? shortId(peer.peerId)}</option>)}
        </datalist>
        <Button variant="outline" size="sm" onClick={add} disabled={!text.trim()}>Add</Button>
      </div>
    </div>
  )
}

/** Free-text chips for model ids. */
export function ChipsInput({ value, onChange, label, suggestions, placeholder }: {
  value: string[]; onChange: (value: string[]) => void; label: string; suggestions?: string[]; placeholder?: string
}) {
  const [text, setText] = useState('')
  const listId = useId()
  const inputId = useId()
  function add() {
    const raw = text.trim()
    if (raw && !value.includes(raw)) onChange([...value, raw])
    setText('')
  }
  return (
    <div className="gc-picker">
      <label className="as-field__label" htmlFor={inputId}>{label}</label>
      {value.length > 0 && (
        <ul className="gc-chips">
          {value.map((item) => (
            <li key={item} className="gc-chip">
              <span className="gc-chip__label">{item}</span>
              <IconButton label={`Remove ${item}`} size="sm" onClick={() => onChange(value.filter((entry) => entry !== item))}><Icon.x size={12} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <div className="gc-inline">
        <input id={inputId} className="as-field__input gc-picker__input" list={listId} value={text} placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }} />
        <datalist id={listId}>{suggestions?.map((item) => <option key={item} value={item} />)}</datalist>
        <Button variant="outline" size="sm" onClick={add} disabled={!text.trim()}>Add</Button>
      </div>
    </div>
  )
}
