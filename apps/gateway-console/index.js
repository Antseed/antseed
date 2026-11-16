import { fileURLToPath } from 'node:url'

/** Directory holding the built console, served by the gateway at /console. */
export const consoleDistDir = fileURLToPath(new URL('./dist/', import.meta.url))
