/** Field errors for the buyer settings form; blank required fields are rejected, not read as 0. */
export function buyerSettingsErrors(values: { input: string; output: string; cached: string; reputation: string }): Partial<Record<keyof typeof values, string>> {
  const errors: Partial<Record<keyof typeof values, string>> = {}
  const check = (key: keyof typeof values, required: boolean, max?: number) => {
    const raw = values[key].trim()
    if (raw === '') { if (required) errors[key] = 'Required.'; return }
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) errors[key] = 'Use a number of 0 or more.'
    else if (max !== undefined && value > max) errors[key] = `At most ${max}.`
  }
  check('input', true)
  check('output', true)
  check('cached', false)
  check('reputation', true, 100)
  return errors
}
