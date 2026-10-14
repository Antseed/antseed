import { useEffect, useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'
const KEY = 'antseed-console-theme'

function read(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function applyStoredTheme(): void {
  const choice = read()
  if (choice !== 'system') document.documentElement.dataset['theme'] = choice
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(read)
  useEffect(() => {
    if (choice === 'system') delete document.documentElement.dataset['theme']
    else document.documentElement.dataset['theme'] = choice
    try {
      if (choice === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, choice)
    } catch { /* storage unavailable */ }
  }, [choice])
  return [choice, setChoice]
}

export function isDarkNow(): boolean {
  const explicit = document.documentElement.dataset['theme']
  if (explicit) return explicit === 'dark'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}
