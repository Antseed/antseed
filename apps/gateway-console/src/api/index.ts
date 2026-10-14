import { createApiClient } from './client'

/** The app-wide client. In mock mode `main.tsx` swaps `window.fetch` for an in-memory API before anything runs. */
export const api = createApiClient()
export * from './client'
