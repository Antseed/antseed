/**
 * Build-time configuration. Operators building the console themselves can
 * override these with Vite env variables.
 */

import { ANTSEED_WALLETCONNECT_PROJECT_ID } from '@antseed/wallet-config'

/** The WalletConnect project shared by the Antseed web apps; set VITE_WALLETCONNECT_PROJECT_ID to use your own. */
export const WALLETCONNECT_PROJECT_ID: string = import.meta.env['VITE_WALLETCONNECT_PROJECT_ID'] || ANTSEED_WALLETCONNECT_PROJECT_ID

/**
 * The Antseed Points site; set VITE_POINTS_URL to override.
 * TODO: replace the placeholder default once the Points domain is chosen.
 */
export const POINTS_URL: string = (import.meta.env['VITE_POINTS_URL'] || 'https://antseedpoints.com').replace(/\/+$/, '')

/** The Points page for a buyer address (points belong to the buyer wallet, not the authorized wallet). */
export function pointsUrl(buyerAddress: string | null | undefined): string {
  return buyerAddress ? `${POINTS_URL}/me?address=${encodeURIComponent(buyerAddress.toLowerCase())}` : `${POINTS_URL}/me`
}
