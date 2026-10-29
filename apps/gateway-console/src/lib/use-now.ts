import { useEffect, useState } from 'react'

/** Re-renders every `ms` while `active`, for countdowns and elapsed timers. */
export function useNow(active: boolean, ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [active, ms])
  return now
}
