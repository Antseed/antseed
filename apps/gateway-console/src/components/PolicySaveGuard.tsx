import { useRef, useState } from 'react'
import type { SaveOptions } from '../api'
import type { RoutingPolicy } from '../api/types'
import { hasEmptyAllowList } from '../lib/policy'
import { guardedSave, type Question, type Saved } from '../lib/policy-save'
import { usePeerLists } from '../lib/queries'
import { ConfirmDialog } from './ui'

export { CANCELLED, type Saved } from '../lib/policy-save'

/**
 * Guards policy and limit writes:
 * - an allow list that lets no seller serve: asked before sending when the
 *   form can tell, or after the gateway answers 400 `empty_allow_list`
 *   (lists that expand to nothing, no overlap with the levels above); then
 *   resent with `confirmEmpty`.
 * - 409 `narrowed` (nothing stored): shows what the levels above leave of
 *   the change and resends with `acceptNarrowed` only if the user agrees.
 * Render `dialog` next to the form.
 */
export function usePolicySaveGuard() {
  const lists = usePeerLists()
  const [question, setQuestion] = useState<Question | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const ask = (next: Question) => new Promise<boolean>((resolve) => {
    resolver.current = resolve
    setQuestion(next)
  })
  const answer = (ok: boolean) => {
    setQuestion(null)
    resolver.current?.(ok)
    resolver.current = null
  }

  const save = <T,>(policies: Array<RoutingPolicy | null | undefined>, send: (options: SaveOptions) => Promise<T>): Promise<Saved<T>> =>
    guardedSave(policies.some((policy) => hasEmptyAllowList(policy, lists.data ?? null)), send, ask)

  const dialog = question?.kind === 'narrowed' ? (
    <ConfirmDialog isOpen tone="primary" title="The levels above allow less" confirmLabel="Save anyway" cancelLabel="Go back"
      onClose={() => answer(false)} onConfirm={() => answer(true)}
      body={<div className="gc-stack gc-stack--tight">
        <span>Part of this change has no effect, because a workspace, member or admin restriction above it is tighter. Saving stores it as you entered it; only what the levels above allow applies.</span>
        {question.lines.length > 0 && <ul className="gc-list">{question.lines.map((line) => <li key={line}>{line}</li>)}</ul>}
      </div>} />
  ) : (
    <ConfirmDialog isOpen={question?.kind === 'empty'} tone="danger" title="Save an empty allow list?" confirmLabel="Save anyway" cancelLabel="Go back"
      onClose={() => answer(false)} onConfirm={() => answer(true)}
      body={<>With this allow list <strong>no seller can serve</strong> requests here (it names no seller, or none the levels above allow), so they fail until you change it. To let any seller serve, choose “Any seller” instead.</>} />
  )
  return { save, dialog }
}
