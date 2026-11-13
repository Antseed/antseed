import type { ReactNode } from 'react'
import { ActionMenu } from '@antseed/ui'
import { Icon } from './icons'

export interface FilterOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  /** Groups the options under a heading. */
  section?: string
}

/**
 * A filter button that opens a checklist: pick any number of options, the
 * button shows how many are on. Like the desktop's Type and Family filters.
 */
export function FilterMenu<T extends string>({ label, values, options, onChange, width = 240 }: {
  label: string
  values: readonly T[]
  options: ReadonlyArray<FilterOption<T>>
  onChange: (values: T[]) => void
  width?: number
}) {
  const on = new Set(values)
  const toggle = (value: T) => onChange(on.has(value) ? values.filter((entry) => entry !== value) : [...values, value])
  return (
    <ActionMenu label={`Filter by ${label.toLowerCase()}`} multiple align="start" width={width} triggerStyle="plain"
      className="as-button as-button--outline as-button--sm gc-filter-menu"
      trigger={<>
        <span>{label}</span>
        {values.length > 0 && <span className="gc-filter-menu__count">{values.length}</span>}
        <Icon.down size={14} />
      </>}
      items={[
        ...options.map((option) => ({
          label: option.label,
          checked: on.has(option.value),
          ...(option.icon ? { icon: option.icon } : {}),
          ...(option.section ? { section: option.section } : {}),
          onSelect: () => toggle(option.value),
        })),
        values.length > 0 && { label: 'Clear', section: ' ', onSelect: () => onChange([]) },
      ]} />
  )
}
