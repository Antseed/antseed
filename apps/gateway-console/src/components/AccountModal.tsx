import { lazy, Suspense, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser'
import { Alert, Button, Modal } from '@antseed/ui'
import { api, errorMessage, isApiError } from '../api'
import type { Member, MeResponse } from '../api/types'
import { useConsole } from '../app/context'
import { formatRelative } from '../lib/format'
import { useConsoleMutation } from '../lib/mutations'
import { ROLE_LABELS } from '../lib/nav'
import { qk, useAuthConfig } from '../lib/queries'
import { assertSameMember, isPasskeyCancel, PASSKEY_CANCELLED, reauthWithPasskey } from '../lib/reauth'
import { Badge, ConfirmDialog } from './ui'

const WalletSignIn = lazy(() => import('../wallet/WalletSignIn'))
const WalletConfirm = lazy(() => import('../wallet/WalletConfirm'))

type Credential = Member['credentials'][number]

/**
 * The signed-in member's own sign-in methods: add a passkey, a wallet or the
 * organization's identity provider, and remove ones they no longer use.
 * Adding one needs a recent sign-in (403 `reauth_required`): the modal asks
 * the member to confirm with an existing passkey or wallet, then to add again.
 * `startWith="wallet"` opens straight into adding a wallet (e.g. linking the
 * workspace's authorized wallet); mount it fresh for that.
 */
export function AccountModal({ isOpen, onClose, startWith, intro, onCredentialAdded }: {
  isOpen: boolean; onClose: () => void
  startWith?: 'wallet'
  /** Shown above the sign-in methods, saying why the modal opened. */
  intro?: ReactNode
  onCredentialAdded?: () => void
}) {
  const { me } = useConsole()
  const queryClient = useQueryClient()
  const config = useAuthConfig(isOpen)
  const [reauth, setReauth] = useState<'idle' | 'needed' | 'done'>('idle')
  const [walletOpen, setWalletOpen] = useState<'add' | 'confirm' | null>(startWith === 'wallet' ? 'add' : null)
  const [error, setError] = useState<unknown>(null)
  const [removing, setRemoving] = useState<Credential | null>(null)
  const [busy, setBusy] = useState(false)
  const credentials = me.member.credentials
  const hasPasskey = credentials.some((credential) => credential.kind === 'passkey')
  const hasWallet = credentials.some((credential) => credential.kind === 'wallet')

  function signedIn(result: MeResponse) {
    assertSameMember(result, me.member.id)
    queryClient.setQueryData(qk.me, result)
  }

  /** Shows an error from adding a sign-in method; one that needs a fresh sign-in asks for it instead. Always handled. */
  function failed(cause: unknown): boolean {
    if (isApiError(cause, 'reauth_required')) {
      setReauth('needed')
      setError(null)
    } else {
      setError(cause)
    }
    return true
  }

  async function addPasskey() {
    setBusy(true)
    setError(null)
    try {
      const options = await api.auth.passkeyRegisterOptions()
      const response = await startRegistration({ optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'] })
      signedIn(await api.auth.passkeyRegisterVerify(response))
      setReauth('idle')
      onCredentialAdded?.()
    } catch (cause) {
      if (isPasskeyCancel(cause)) setError(new Error(PASSKEY_CANCELLED))
      else failed(cause)
    } finally {
      setBusy(false)
    }
  }

  async function confirmWithPasskey() {
    setBusy(true)
    setError(null)
    try {
      signedIn(await reauthWithPasskey())
      setReauth('done')
    } catch (cause) {
      setError(isPasskeyCancel(cause) ? new Error(PASSKEY_CANCELLED) : cause)
    } finally {
      setBusy(false)
    }
  }

  const remove = useConsoleMutation({
    mutationFn: (credential: Credential) => api.members.removeCredential(me.member.id, credential.id),
    onSuccess: () => setRemoving(null),
    invalidate: [qk.me],
  })

  const last = credentials.length <= 1
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" eyebrow={ROLE_LABELS[me.member.orgRole]} title={me.member.label} subtitle={me.member.email ?? undefined}>
      <div className="gc-stack">
        {intro}
        <section className="gc-stack gc-stack--tight">
          <div className="as-field__label">Your sign-in methods</div>
          {credentials.length === 0 ? (
            <Alert tone="info">You signed in through your organization's access proxy and have no passkey or wallet here. Add one to approve sensitive actions, such as authorizing a withdrawal wallet.</Alert>
          ) : (
            <ul className="gc-list gc-credentials">
              {credentials.map((credential) => (
                <li key={credential.id} className="gc-inline gc-inline--between">
                  <span className="gc-credential">
                    <Badge>{credential.kind}</Badge> <span className="gc-credential__label">{credential.label}</span>
                    <span className="gc-muted"> · added {formatRelative(credential.createdAt)} · last used {formatRelative(credential.lastUsedAt)}</span>
                  </span>
                  <Button variant="ghost" size="sm" disabled={last} title={last ? 'Add another sign-in method first' : undefined}
                    onClick={() => setRemoving(credential)}>Remove</Button>
                </li>
              ))}
            </ul>
          )}
          {last && credentials.length === 1 && <p className="gc-fineprint">This is your only sign-in method. Add another before removing it.</p>}
        </section>

        {reauth === 'needed' && (
          <Alert tone="info" title="Confirm it is you">
            <div className="gc-stack gc-stack--tight">
              <span>Adding a sign-in method needs a recent sign-in. Confirm with one you already have, then add the new one.</span>
              <div className="gc-inline gc-inline--wrap">
                {hasPasskey && <Button size="sm" disabled={busy} onClick={() => void confirmWithPasskey()}>Confirm with a passkey</Button>}
                {hasWallet && walletOpen !== 'confirm' && <Button size="sm" variant="outline" onClick={() => setWalletOpen('confirm')}>Confirm with a wallet</Button>}
              </div>
              {walletOpen === 'confirm' && (
                <Suspense fallback={<Button size="sm" disabled>Loading wallets…</Button>}>
                  <WalletConfirm onConfirmed={(result) => { signedIn(result); setReauth('done'); setWalletOpen(null) }} />
                </Suspense>
              )}
              {!hasPasskey && !hasWallet && <span>Sign out and sign in again, then add it.</span>}
            </div>
          </Alert>
        )}
        {reauth === 'done' && <Alert tone="success">Confirmed. Add the new sign-in method now.</Alert>}

        {config.data && (
          <section className="gc-stack gc-stack--tight">
            <div className="as-field__label">Add a sign-in method</div>
            <div className="gc-inline gc-inline--wrap">
              {config.data.passkey && (
                <Button variant="outline" size="sm" disabled={busy || !browserSupportsWebAuthn()} onClick={() => void addPasskey()}>
                  {busy ? 'Waiting for your passkey…' : 'Add a passkey'}
                </Button>
              )}
              {config.data.wallet && walletOpen !== 'add' && <Button variant="outline" size="sm" onClick={() => setWalletOpen('add')}>Add a wallet</Button>}
              {config.data.oidc && <Button variant="outline" size="sm" href={api.auth.oidcLinkUrl()}>Link {config.data.oidc.label}</Button>}
            </div>
            {walletOpen === 'add' && (
              <Suspense fallback={<Button size="sm" disabled>Loading wallets…</Button>}>
                <WalletSignIn autoConnect actionLabel={(address) => `Add ${address} as a sign-in method`} onError={failed}
                  onSignedIn={(result) => { signedIn(result); setWalletOpen(null); setReauth('idle'); onCredentialAdded?.() }} />
              </Suspense>
            )}
            <p className="gc-fineprint">A wallet you add can become this workspace's withdrawal wallet only 24 hours later.</p>
          </section>
        )}
        {error ? <Alert tone="danger">{errorMessage(error)}</Alert> : null}
        <div className="gc-actions"><Button onClick={onClose}>Done</Button></div>
      </div>
      <ConfirmDialog isOpen={removing !== null} busy={remove.isPending} error={remove.error}
        onClose={() => { setRemoving(null); remove.reset() }} onConfirm={() => removing && remove.mutate(removing)}
        title="Remove this sign-in method?" confirmLabel="Remove"
        body={`You can no longer sign in with ${removing?.label ?? 'it'}.`} />
    </Modal>
  )
}
