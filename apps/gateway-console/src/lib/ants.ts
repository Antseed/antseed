/**
 * ANTS amounts on the wire are decimal strings ("12.5"), like USDC. A long
 * integer string (15+ digits) is read as 18-decimal base units, so a raw
 * on-chain value still displays correctly.
 */
export function formatAnts(value: string | null | undefined): string {
  if (!value) return '0 ANTS'
  const raw = value.trim()
  let whole: string
  let fraction: string
  if (/^\d{15,}$/.test(raw)) {
    const units = BigInt(raw)
    whole = (units / 10n ** 18n).toString()
    fraction = (units % 10n ** 18n).toString().padStart(18, '0')
  } else {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(raw)
    if (!match) return `${raw} ANTS`
    whole = match[1]!
    fraction = match[2] ?? ''
  }
  const shown = fraction.slice(0, 4).replace(/0+$/, '')
  return `${BigInt(whole).toLocaleString('en-US')}${shown ? `.${shown}` : ''} ANTS`
}

export function antsIsPositive(value: string | null | undefined): boolean {
  return !!value && /[1-9]/.test(value)
}
