import { useState } from 'react'
import { Button, Modal } from '@antseed/ui'
import type { RoutingPolicy } from '../api/types'
import { draftToPolicy, policyOrNull, policyToDraft, type PolicyDraft } from '../lib/policy'
import { usePeerLists, usePeers } from '../lib/queries'
import { PolicyEditor } from './PolicyEditor'
import { PolicyChips } from './PolicySummary'

/** Draft state for a nullable `routingPolicy` field. `build()` throws a readable error on invalid input. */
export function usePolicyDraft(initial: RoutingPolicy | null | undefined) {
  const [draft, setDraft] = useState<PolicyDraft>(() => policyToDraft(initial))
  const lists = usePeerLists()
  return {
    draft,
    setDraft,
    reset: (policy: RoutingPolicy | null | undefined) => setDraft(policyToDraft(policy)),
    build: (): RoutingPolicy | null => policyOrNull(draftToPolicy(draft, lists.data ?? null)),
  }
}

/** The draft as a policy, or the validation message when it is not valid. */
export function draftStatus(draft: PolicyDraft, lists: Parameters<typeof draftToPolicy>[1]): { policy: RoutingPolicy | null; error: string | null } {
  try { return { policy: draftToPolicy(draft, lists), error: null } } catch (error) { return { policy: null, error: error instanceof Error ? error.message : String(error) } }
}

/**
 * Routing policy inside create/edit forms: one line of chips and an Edit
 * button; the editor opens in its own dialog. Edits go into the form's
 * draft (saved with the form); Cancel restores what was there before.
 */
export function PolicyFieldset({ draft, setDraft, title = 'Routing policy' }: { draft: PolicyDraft; setDraft: (draft: PolicyDraft) => void; title?: string }) {
  const peers = usePeers()
  const lists = usePeerLists()
  const [before, setBefore] = useState<PolicyDraft | null>(null)
  const status = draftStatus(draft, lists.data ?? null)
  const cancel = () => { if (before) setDraft(before); setBefore(null) }
  return (
    <div className="gc-policy-row">
      <div className="gc-policy-row__text">
        <span className="as-field__label">{title}</span>
        <PolicyChips policy={status.policy} invalid={status.error !== null} />
      </div>
      <Button size="sm" variant="outline" onClick={() => setBefore(draft)}>Edit</Button>
      <Modal isOpen={before !== null} onClose={() => setBefore(null)} size="xl" title={title}
        subtitle="Blank settings inherit from the level above, which this can only narrow. Saved with the form."
        footer={<>
          {status.error && <span className="gc-warn gc-footer-note">{status.error}</span>}
          <Button variant="ghost" onClick={cancel}>Cancel</Button>
          <Button onClick={() => setBefore(null)}>Done</Button>
        </>}>
        <PolicyEditor value={draft} onChange={setDraft} peers={peers.data} lists={lists.data ?? []} />
      </Modal>
    </div>
  )
}

