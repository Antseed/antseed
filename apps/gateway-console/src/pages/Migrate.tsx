import { useState, type ReactNode } from 'react'
import { Alert, CodeBlock, TextField } from '@antseed/ui'
import type { GatewayExposure } from '../api/types'
import { useConsole } from '../app/context'
import { Icon } from '../components/icons'
import { Badge, PageHeader, Panel } from '../components/ui'
import { migrationCommands, normalizeDomain } from '../lib/exposure'
import { isOrgAdmin } from '../lib/nav'
import { useStatus } from '../lib/queries'
import '../styles/exposure.scss'

const SERVER_GUIDE = 'https://antseed.com/docs/guides/gateway-server#move-a-local-gateway-to-a-server'
const TUNNEL_GUIDE = 'https://antseed.com/docs/guides/public-tunnels'

const MODE_LABELS: Record<GatewayExposure['mode'], string> = { local: 'This computer only', lan: 'Your network only', public: 'Public' }

function Step({ n, title, children }: { n: number; title: ReactNode; children: ReactNode }) {
  return (
    <li className="gc-migrate__step">
      <span className="gc-migrate__num" aria-hidden="true">{n}</span>
      <div className="gc-migrate__body">
        <h3 className="gc-migrate__title">{title}</h3>
        {children}
      </div>
    </li>
  )
}

function Why({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="gc-migrate__why">
      <span className="gc-migrate__why-icon" aria-hidden="true">{icon}</span>
      <div>
        <div className="gc-migrate__why-title">{title}</div>
        <p className="gc-migrate__why-text">{children}</p>
      </div>
    </div>
  )
}

function CurrentState({ exposure }: { exposure: GatewayExposure }) {
  return (
    <div className="gc-migrate__now">
      <div className="gc-migrate__now-head">
        <span className="gc-muted">Right now</span>
        <Badge tone={exposure.mode === 'public' ? 'neutral' : 'warning'}>{MODE_LABELS[exposure.mode]}</Badge>
        {exposure.listenHost && <code className="gc-migrate__addr">{exposure.listenHost}</code>}
      </div>
      {exposure.reasons.length > 0 && (
        <ul className="gc-migrate__reasons">
          {exposure.reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
    </div>
  )
}

/**
 * Moving a gateway that runs on someone's computer to a server. The console
 * only shows commands: the bundle (with wallet keys) is made and restored by
 * the CLI and never passes through the browser.
 */
export default function MigratePage() {
  const { viewer } = useConsole()
  const status = useStatus()
  const [domainInput, setDomainInput] = useState('')
  const [server, setServer] = useState('')
  const domain = normalizeDomain(domainInput)
  const commands = migrationCommands({ domain, server })
  const exposure = status.data?.exposure

  if (!isOrgAdmin(viewer)) {
    return <Alert tone="warning" title="Not available">Only organization owners and admins can move the gateway.</Alert>
  }
  return (
    <div className="gc-page gc-migrate">
      <PageHeader
        title="Move this gateway to a server"
        description="Keep every key, member, workspace, wallet and its usage history. Your apps only need the new base URL."
      />
      {exposure && <CurrentState exposure={exposure} />}
      {exposure?.mode === 'public' && (
        <Alert tone="info" title="Already public">This gateway has a public address ({exposure.publicUrl}). You can still move it to another machine with the same steps.</Alert>
      )}

      <div className="gc-migrate__whys">
        <Why icon={<Icon.activity size={16} />} title="Always on">Keys keep working when your laptop sleeps, travels or restarts.</Why>
        <Why icon={<Icon.shield size={16} />} title="HTTPS on your domain">Automatic TLS at an address like https://llm.example.com, with passkeys and single sign-on.</Why>
        <Why icon={<Icon.members size={16} />} title="Team access">Teammates, CI and hosted tools reach it from anywhere, each with their own key and budget.</Why>
      </div>

      <Panel
        title={<span className="gc-inline">Recommended: a small Linux server <Badge tone="neutral">About 10 minutes</Badge></span>}
        description="Any VPS with a public IP works (1 vCPU, 1 GB RAM). Point a DNS name at it and open ports 80 and 443."
      >
        <div className="gc-migrate__inputs">
          <TextField label="Domain for the gateway" placeholder="llm.example.com" value={domainInput} onChange={(event) => setDomainInput(event.target.value)}
            error={domainInput.trim() && !domain ? 'Enter a host name such as llm.example.com' : undefined} spellCheck={false} autoCapitalize="off" />
          <TextField label="Server SSH login" placeholder="user@your-server" value={server} onChange={(event) => setServer(event.target.value)} spellCheck={false} autoCapitalize="off" mono />
        </div>
        <ol className="gc-migrate__steps">
          <Step n={1} title="Export it on this computer">
            <p>Writes a password-protected bundle readable only by you. It holds the wallet keys, so keep the password apart from the file.</p>
            <CodeBlock code={commands.exportBundle} label="This computer" />
          </Step>
          <Step n={2} title="Copy the bundle to the server">
            <CodeBlock code={commands.copy} label="This computer" />
          </Step>
          <Step n={3} title="Install the gateway on the server and import the bundle">
            <p>Installs the CLI, restores the bundle as the service user, starts the buyer and gateway with automatic HTTPS. It asks for the bundle password.</p>
            <CodeBlock code={commands.install} label="Server" />
          </Step>
          <Step n={4} title="Point your apps at the new address">
            <p>API keys stay the same. Only the base URL changes:</p>
            <CodeBlock code={commands.baseUrl} label="New base URL" />
          </Step>
          <Step n={5} title="Stop the gateway on this computer">
            <p>
              Press Ctrl+C where <code>antseed gateway start</code> and <code>antseed buyer start</code> run (or quit the desktop app's gateway),
              then delete the bundle on both machines. Never run both gateways: two buyers paying from the same wallet conflict.
            </p>
            <CodeBlock code={commands.stop} label="Both machines" />
          </Step>
        </ol>
        <div className="gc-migrate__note">
          <strong>Signing in afterwards.</strong> Everyone signs in again on the new address. Wallet and single sign-on keep working;
          passkeys are tied to the domain they were made on, so add a new one with a one-time link from the server:
          <CodeBlock code={commands.recover} label="Server" />
        </div>
        <p className="gc-fineprint">
          <Icon.shield size={12} /> Wallet keys never pass through this browser: the console only shows commands. <a className="gc-link" href={SERVER_GUIDE} target="_blank" rel="noreferrer">Full guide</a>
        </p>
      </Panel>

      <Panel title="Alternative: keep it here behind a Cloudflare tunnel" description="Gives this computer a public HTTPS address without moving anything.">
        <div className="gc-stack">
          <CodeBlock code={commands.tunnel} label="This computer, instead of gateway start" />
          <ul className="gc-migrate__caveats">
            <li>Keys still stop working whenever this computer sleeps, loses its connection or restarts.</li>
            <li>Needs a Cloudflare account and a named tunnel whose public hostname points at <code>http://localhost:8379</code>.</li>
            <li>Traffic and model responses run through your home or office connection.</li>
          </ul>
          <a className="gc-link" href={TUNNEL_GUIDE} target="_blank" rel="noreferrer">Tunnel guide <Icon.external size={12} /></a>
        </div>
      </Panel>
    </div>
  )
}
