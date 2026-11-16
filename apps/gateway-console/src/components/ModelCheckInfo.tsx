import type { ModelCheckView } from '../api/types'
import { modelCheckLabel, modelCheckTitle } from '../lib/model-check'

/**
 * The auditors' verdict on one seller's offer of a model, with a link to the
 * audit on the explorer: DIFF gets the amber dot, SAME a green one. Nothing
 * when the offer has no live verdict.
 */
export function ModelCheckInfo({ check }: { check: ModelCheckView | undefined }) {
  if (!check) return null
  const link = check.auditUrl && (
    <a className="gc-verified-link" href={check.auditUrl} target="_blank" rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}><span className="gc-nowrap">View audit</span></a>
  )
  const same = check.verdict === 'same'
  return (
    <span className={`gc-status-line gc-status-line--${same ? 'ok' : 'attention'}`} title={modelCheckTitle(check)}>
      <span className={same ? 'gc-attention gc-attention--ok' : 'gc-attention'} aria-hidden="true" />
      <span className="gc-nowrap">{modelCheckLabel(check)}</span>{link}
    </span>
  )
}
