import { startAuthentication } from '@simplewebauthn/browser'
import { api, isApiError, type ApiClient } from '../api'
import type { MeResponse } from '../api/types'

/**
 * Some actions (authorizing a withdrawal wallet) need a fresh sign-in: the
 * API answers 403 `reauth_required`. `withReauth` runs the action, and on
 * that error asks `reauthenticate` for a new sign-in, then retries once.
 */
export async function withReauth<T>(action: () => Promise<T>, reauthenticate: () => Promise<unknown>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (!isApiError(error, 'reauth_required')) throw error
    await reauthenticate()
    return action()
  }
}

/**
 * Confirms the current session with one of the member's own passkeys. The
 * server only refreshes this session's sign-in time; another member's
 * passkey is refused (403 `reauth_wrong_member`) and never switches accounts.
 */
export async function reauthWithPasskey(client: Pick<ApiClient, 'auth'> = api): Promise<MeResponse> {
  const options = await client.auth.reauthPasskeyOptions()
  const response = await startAuthentication({ optionsJSON: options as Parameters<typeof startAuthentication>[0]['optionsJSON'] })
  return client.auth.reauthPasskeyVerify(response)
}

/** Confirms the current session by signing the gateway's nonce with one of the member's wallets. */
export async function reauthWithWallet(address: string, sign: (message: string) => Promise<string>, client: Pick<ApiClient, 'auth'> = api): Promise<MeResponse> {
  const { message } = await client.auth.reauthWalletNonce(address)
  return client.auth.reauthWalletVerify(message, await sign(message))
}

/** Belt and braces: throws if a confirmation answered for someone else (the server already refuses that). */
export function assertSameMember(me: MeResponse, memberId: string): void {
  if (me.kind !== 'member' || me.me.member.id !== memberId) {
    throw new Error('That sign-in belongs to a different account. Reload the page and sign in as yourself.')
  }
}

export const PASSKEY_CANCELLED = 'The passkey prompt was closed.'

/** The browser's passkey prompt was dismissed (WebAuthn `NotAllowedError`). */
export function isPasskeyCancel(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotAllowedError'
}
