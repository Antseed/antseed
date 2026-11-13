/**
 * Build-time configuration. Operators building the console themselves can
 * override these with Vite env variables.
 */

import { ANTSEED_WALLETCONNECT_PROJECT_ID } from '@antseed/wallet-config'

/** The WalletConnect project shared by the Antseed web apps; set VITE_WALLETCONNECT_PROJECT_ID to use your own. */
export const WALLETCONNECT_PROJECT_ID: string = import.meta.env['VITE_WALLETCONNECT_PROJECT_ID'] || ANTSEED_WALLETCONNECT_PROJECT_ID
