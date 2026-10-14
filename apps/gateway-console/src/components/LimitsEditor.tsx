import { TextField } from '@antseed/ui'
import type { LimitPeriod } from '../api/types'
import { LIMIT_PERIODS, PERIOD_LABELS } from '../lib/format'
import type { LimitsDraft } from '../lib/limits'

/** Four optional USD budgets (UTC periods; weeks start Monday). Blank means no limit. */
export function LimitsEditor({ value, onChange, idPrefix }: { value: LimitsDraft; onChange: (value: LimitsDraft) => void; idPrefix: string }) {
  return (
    <div className="gc-grid gc-grid--4">
      {LIMIT_PERIODS.map((period: LimitPeriod) => (
        <TextField key={period} id={`${idPrefix}-${period}`} label={PERIOD_LABELS[period]} inputMode="decimal" placeholder="No limit"
          value={value[period]} onChange={(event) => onChange({ ...value, [period]: event.target.value })} />
      ))}
    </div>
  )
}
