import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser'
import { Alert, Button, Card, Skeleton, TextField } from '@antseed/ui'
import { api, errorMessage, isApiError } from '../api'
import type { AuthConfig, Enrollment, MeResponse } from '../api/types'
import { Brand, ThemeToggle } from '../components/Shell'
import { ROLE_LABELS } from '../lib/nav'
import { qk, useAuthConfig } from '../lib/queries'
import { isPasskeyCancel, PASSKEY_CANCELLED } from '../lib/reauth'
import { navigate } from '../lib/router'

const WalletSignIn = lazy(() => import('../wallet/WalletSignIn'))

/** Friendly copy for auth error codes (from API errors or `?error=` after an OIDC redirect). */
const AUTH_ERRORS: Record<string, string> = {
  not_invited: 'This account has not been invited to this console. Ask an admin for an invite link.',
  invite_expired: 'This invite link has expired. Ask an admin for a new one.',
  invite_used: 'This invite link was already used. Sign in instead.',
  invalid_token: 'This link is not valid. Check that you copied all of it.',
  setup_complete: 'This console is already set up. Sign in instead.',
  member_disabled: 'Your access to this console has been turned off.',
  unknown_credential: 'This passkey or wallet is not registered here.',
  key_revoked: 'This API key has been revoked.',
  invalid_key: 'That API key is not valid.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  key_expired: 'This API key has expired.',
  not_linked: 'This account is not linked to a member yet. Sign in another way and link it from your profile, or use your invite link.',
  invalid_enrollment: 'This sign-up link has expired. Open your invite link again, or ask for a new one.',
  unauthenticated: 'Sign in first.',
  oidc_denied: 'Single sign-on was cancelled.',
  oidc_state: 'The single sign-on attempt expired. Try again.',
  oidc_failed: 'Single sign-on could not be verified. Try again, or use another sign-in method.',
  oidc_unavailable: 'The single sign-on provider could not be reached. Try again later.',
  reauth_required: 'Linking a sign-in provider needs a fresh sign-in. Go back to the console, confirm it is you under Your sign-in methods, then link it again.',
  access_reauth_required: 'Your Cloudflare Access sign-in is more than 5 minutes old. Sign out of Cloudflare Access, sign in again, then link the provider again.',
}

/** Errors from linking a provider to a signed-in account: the session is still valid, so offer the way back. */
const LINK_ERRORS = new Set(['reauth_required', 'access_reauth_required'])

function authErrorText(error: unknown): string {
  if (isApiError(error) && AUTH_ERRORS[error.code]) return AUTH_ERRORS[error.code]!
  return errorMessage(error)
}

function AuthLayout({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="gc-auth">
      <div className="gc-auth__theme"><ThemeToggle /></div>
      <div className="gc-auth__logo"><Brand to={null} tagged size={30} /></div>
      <Card className="gc-auth__card">
        <h1 className="gc-auth__title">{title}</h1>
        {subtitle && <p className="gc-auth__subtitle">{subtitle}</p>}
        {children}
      </Card>
      <p className="gc-auth__foot">Self-hosted Antseed gateway</p>
    </div>
  )
}

function useSignedIn() {
  const queryClient = useQueryClient()
  return (me: MeResponse) => {
    queryClient.setQueryData(qk.me, me)
    navigate(me.kind === 'key' ? 'key' : 'overview', { replace: true })
  }
}

function PasskeyButton({ label, run, primary }: { label: string; run: () => Promise<void>; primary?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = browserSupportsWebAuthn()
  return (
    <div className="gc-stack gc-stack--tight">
      <Button fullWidth variant={primary ? 'primary' : 'outline'} disabled={busy || !supported} onClick={async () => {
        setBusy(true)
        setError(null)
        try { await run() } catch (cause) {
          setError(isPasskeyCancel(cause) ? PASSKEY_CANCELLED : authErrorText(cause))
        } finally { setBusy(false) }
      }}>{busy ? 'Waiting for your passkey…' : label}</Button>
      {!supported && <p className="gc-fineprint">This browser does not support passkeys.</p>}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  )
}

/** The wallet stack (RainbowKit, WalletConnect, wagmi) is large: load it only once the user picks this method. */
function WalletMethod({ enrollment, onSignedIn }: { enrollment?: string; onSignedIn: (me: MeResponse) => void }) {
  const [open, setOpen] = useState(false)
  if (!open) return <Button variant="outline" fullWidth onClick={() => setOpen(true)}>Sign in with a wallet</Button>
  return (
    <Suspense fallback={<Button variant="outline" fullWidth disabled>Loading wallets…</Button>}>
      <WalletSignIn enrollment={enrollment} onSignedIn={onSignedIn} autoConnect />
    </Suspense>
  )
}

function Divider() {
  return <div className="gc-divider"><span>or</span></div>
}

function ApiKeyForm({ onSignedIn }: { onSignedIn: (me: MeResponse) => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <form className="gc-stack gc-stack--tight" onSubmit={async (event) => {
      event.preventDefault()
      setBusy(true)
      setError(null)
      try { onSignedIn(await api.auth.apiKey(key.trim())) } catch (cause) { setError(authErrorText(cause)) } finally { setBusy(false) }
    }}>
      <TextField label="API key" type="password" autoComplete="off" placeholder="Paste your key to see its usage" value={key}
        onChange={(event) => setKey(event.target.value)} />
      <Button type="submit" variant="outline" fullWidth disabled={busy || !key.trim()}>{busy ? 'Checking…' : 'View key usage'}</Button>
      {error && <Alert tone="danger">{error}</Alert>}
    </form>
  )
}

function PasskeyMethod({ mode, enrollment, onSignedIn }: { mode: 'login' | 'enroll'; enrollment?: string; onSignedIn: (me: MeResponse) => void }) {
  if (mode === 'login') {
    return <PasskeyButton primary label="Sign in with a passkey" run={async () => {
      const options = await api.auth.passkeyLoginOptions()
      const response = await startAuthentication({ optionsJSON: options as Parameters<typeof startAuthentication>[0]['optionsJSON'] })
      onSignedIn(await api.auth.passkeyLoginVerify(response))
    }} />
  }
  return <PasskeyButton primary label="Create a passkey" run={async () => {
    const options = await api.auth.passkeyRegisterOptions(enrollment)
    const response = await startRegistration({ optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'] })
    onSignedIn(await api.auth.passkeyRegisterVerify(response, enrollment))
  }} />
}

function MethodList({ config, enrollment, onSignedIn, mode }: { config: AuthConfig; enrollment?: string; onSignedIn: (me: MeResponse) => void; mode: 'login' | 'enroll' }) {
  const methods: ReactNode[] = []
  if (config.passkey) methods.push(<PasskeyMethod key="passkey" mode={mode} enrollment={enrollment} onSignedIn={onSignedIn} />)
  if (config.wallet) methods.push(<WalletMethod key="wallet" enrollment={enrollment} onSignedIn={onSignedIn} />)
  if (config.oidc) {
    methods.push(
      <Button key="oidc" variant="outline" fullWidth href={api.auth.oidcStartUrl(enrollment)}>Continue with {config.oidc.label}</Button>,
    )
  }
  if (methods.length === 0) {
    return <Alert tone="warning">No sign-in method is enabled on this gateway. Check the gateway's console auth settings.</Alert>
  }
  return <div className="gc-stack">{methods}</div>
}

export function LoginPage() {
  const config = useAuthConfig()
  const onSignedIn = useSignedIn()
  const errorCode = new URLSearchParams(window.location.search).get('error')

  return (
    <AuthLayout title="Sign in" subtitle="Manage keys, budgets, routing and funding for this gateway.">
      {errorCode && (
        <Alert tone="danger" action={LINK_ERRORS.has(errorCode)
          ? <Button size="sm" variant="outline" onClick={() => navigate('overview?account=1', { replace: true })}>Back to the console</Button>
          : undefined}>
          {AUTH_ERRORS[errorCode] ?? 'Sign-in did not complete. Try again.'}
        </Alert>
      )}
      {config.isLoading && <div className="gc-stack"><Skeleton height={34} /><Skeleton height={34} /></div>}
      {config.error ? <Alert tone="danger" title="Could not reach the gateway">{errorMessage(config.error)}</Alert> : null}
      {config.data && (
        <div className="gc-stack">
          {config.data.setupRequired && (
            <Alert tone="info" title="Not set up yet">
              Open the one-time setup link the gateway printed when it started (<code>antseed gateway start</code>), or ask the operator for it.
            </Alert>
          )}
          <MethodList config={config.data} mode="login" onSignedIn={onSignedIn} />
          {config.data.cloudflareAccess && (
            <p className="gc-fineprint">This gateway also accepts Cloudflare Access. If you signed in there, reload this page.</p>
          )}
          {config.data.apiKeyLogin && <><Divider /><ApiKeyForm onSignedIn={onSignedIn} /></>}
        </div>
      )}
    </AuthLayout>
  )
}

/**
 * /setup#<token> and /invite#<token>: register a first credential for the owner or an invited member.
 * /recover#<token>: a one-time link from `antseed gateway console-link --recover` adds one for an existing member.
 */
export function EnrollPage({ kind }: { kind: 'setup' | 'invite' | 'recover' }) {
  // Keep the token in memory and drop it from the address bar so it does not linger in history.
  const [token, setToken] = useState(() => window.location.hash.replace(/^#/, ''))
  useEffect(() => {
    const strip = () => {
      const value = window.location.hash.replace(/^#/, '')
      if (!value) return
      setToken(value)
      window.history.replaceState(null, '', window.location.pathname)
    }
    strip()
    window.addEventListener('hashchange', strip)
    return () => window.removeEventListener('hashchange', strip)
  }, [])
  const onSignedIn = useSignedIn()
  const config = useAuthConfig()
  const enrollment = useQuery({
    queryKey: ['enrollment', kind, token],
    queryFn: () => (kind === 'setup' ? api.auth.setup(token)
      : kind === 'recover' ? api.request<Enrollment>('POST', '/auth/recover', { body: { token } })
        : api.auth.invite(token)),
    enabled: token !== '',
    retry: false,
    staleTime: Infinity,
  })

  const title = kind === 'setup' ? 'Set up your Antseed console' : kind === 'recover' ? 'Add a sign-in method' : 'You are invited'
  if (!token) {
    return (
      <AuthLayout title={title}>
        <Alert tone="danger">This link is missing its token. Open the full link you were given.</Alert>
        <Button variant="ghost" onClick={() => navigate('login')}>Go to sign in</Button>
      </AuthLayout>
    )
  }
  return (
    <AuthLayout title={title} subtitle={enrollment.data
      ? kind === 'recover'
        ? <>Welcome back, <strong>{enrollment.data.label}</strong>. Add a passkey, wallet or single sign-on to sign in on this address.</>
        : <>Welcome, <strong>{enrollment.data.label}</strong>. You will join as {ROLE_LABELS[enrollment.data.orgRole].toLowerCase()}. Choose how you sign in.</>
      : 'Checking your link…'}>
      {(enrollment.isLoading || config.isLoading) && <div className="gc-stack"><Skeleton height={34} /><Skeleton height={34} /></div>}
      {enrollment.error ? (
        <div className="gc-stack">
          <Alert tone="danger">{authErrorText(enrollment.error)}</Alert>
          <Button variant="ghost" onClick={() => navigate('login')}>Go to sign in</Button>
        </div>
      ) : null}
      {enrollment.data && config.data && (
        <div className="gc-stack">
          <MethodList config={config.data} mode="enroll" enrollment={enrollment.data.enrollment} onSignedIn={onSignedIn} />
          <p className="gc-fineprint">A passkey uses your device's screen lock or a security key. Nothing to remember.</p>
        </div>
      )}
    </AuthLayout>
  )
}
