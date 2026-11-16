import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@antseed/ui/styles'
import './styles/app.scss'
import { App } from './app/App'
import { applyStoredTheme } from './app/theme'

applyStoredTheme()

async function boot() {
  // Dev-only fake API; the condition is a build-time constant, so production bundles drop the mock entirely.
  if (import.meta.env.VITE_MOCK === '1') {
    const { installMockApi } = await import('./mock/server')
    installMockApi()
  }
  const root = document.getElementById('root')
  if (!root) throw new Error('#root element is missing')
  createRoot(root).render(<StrictMode><App /></StrictMode>)
}

void boot()
