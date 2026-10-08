/** `YYYY-MM-DD` (UTC) for a date input. */
export function toDateInput(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : ''
}

/** Start (00:00:00.000 UTC) or end (23:59:59.999 UTC) of a date input's day; undefined when blank or invalid. */
export function fromDateInput(value: string, edge: 'start' | 'end'): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const ms = Date.parse(`${value}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`)
  return Number.isFinite(ms) ? ms : undefined
}
