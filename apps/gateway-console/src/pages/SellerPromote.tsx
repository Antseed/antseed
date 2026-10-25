import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, CopyButton, TextField, useToast } from '@antseed/ui'
import { api } from '../api'
import type { SellerPromote as Promote, SellerVerificationStatus } from '../api/types'
import { SellerPage } from '../components/SellerPage'
import { Badge, CodeBlock, EmptyState, ErrorAlert, LoadingRows, Mono, Panel } from '../components/ui'
import { formatRelative } from '../lib/format'
import { qk, useSellerCard, useSellerPromote } from '../lib/queries'
import '../styles/seller.scss'

/** Help buyers find and trust this seller: profile link, a shareable card, usage snippets and identity verification. */
export default function SellerPromote() {
  const promote = useSellerPromote()
  return (
    <SellerPage title="Promote" description={() => 'Share your seller, and verify a domain or GitHub account so buyers can trust it.'}>
      {() => {
        if (promote.isLoading) return <LoadingRows rows={6} />
        if (promote.error) return <ErrorAlert error={promote.error} onRetry={() => void promote.refetch()} />
        const data = promote.data!
        return (
          <>
            {!data.peerId && <p className="gc-seller-notice"><span className="gc-attention" aria-hidden="true" />The seller has not reported its peer id yet. Start it once to fill in links and snippets.</p>}
            <div className="gc-grid gc-grid--2">
              <ProfilePanel data={data} />
              <CardPanel data={data} />
            </div>
            <SnippetsPanel data={data} />
            <VerificationPanel data={data} />
          </>
        )
      }}
    </SellerPage>
  )
}

function ProfilePanel({ data }: { data: Promote }) {
  return (
    <Panel title="Public profile" description="Your page on the explorer: stake, volume and history anyone can check.">
      <div className="gc-stack">
        {data.profileUrl ? (
          <div className="gc-inline gc-inline--wrap">
            <a className="gc-link gc-seller-wrap" href={data.profileUrl} target="_blank" rel="noreferrer">{data.profileUrl.replace(/^https?:\/\//, '')}</a>
            <CopyButton value={data.profileUrl} />
          </div>
        ) : <p className="gc-muted">No explorer is configured for this chain.</p>}
        {data.peerId && <div className="gc-inline gc-inline--wrap"><span className="gc-fineprint">Peer id</span><Mono>{data.peerId}</Mono><CopyButton value={data.peerId} /></div>}
      </div>
    </Panel>
  )
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

function CardPanel({ data }: { data: Promote }) {
  // Rendered by the seller service (the same SVG `antseed seller promote --card` writes).
  const card = useSellerCard()
  const svg = card.data ?? null
  const slug = (data.displayName || 'antseed-seller').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'antseed-seller'
  const png = () => {
    if (!svg) return
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 1200
      canvas.height = 680
      canvas.getContext('2d')!.drawImage(image, 0, 0, 1200, 680)
      canvas.toBlob((blob) => { if (blob) download(blob, `${slug}.png`) }, 'image/png')
    }
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }
  return (
    <Panel title="Seller card" description="Your name, trust score and prices, ready to post.">
      {card.isLoading ? <LoadingRows rows={4} /> : card.error ? <ErrorAlert error={card.error} onRetry={() => void card.refetch()} /> : (
        <div className="gc-seller-card">
          <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg ?? '')}`} alt={`Seller card for ${data.displayName || 'this seller'}`} width={600} height={340} />
          <div className="gc-actions gc-actions--start">
            <Button size="sm" variant="outline" onClick={() => svg && download(new Blob([svg], { type: 'image/svg+xml' }), `${slug}.svg`)}>Download SVG</Button>
            <Button size="sm" variant="outline" onClick={png}>Download PNG</Button>
          </div>
        </div>
      )}
    </Panel>
  )
}

function SnippetsPanel({ data }: { data: Promote }) {
  const peer = data.peerId ?? '<peerId>'
  const first = data.services[0]?.service ?? '<model>'
  const ids = data.services.map((service) => `${peer}@${service.service}`).join('\n')
  const curl = `curl http://localhost:8377/v1/chat/completions \\\n  -H 'content-type: application/json' \\\n  -d '{\n    "model": "${peer}@${first}",\n    "messages": [{"role": "user", "content": "Hello"}]\n  }'`
  return (
    <Panel title="Send buyers straight to you" description="A model id with your peer id in front always routes to you, in the gateway console, any OpenAI-compatible client or the local buyer.">
      {data.services.length === 0 ? <EmptyState title="No models" body="The seller's config lists no services." /> : (
        <div className="gc-grid gc-grid--2">
          <CodeBlock label="Pinned model ids" code={ids} />
          <CodeBlock label="Through a local buyer (antseed buyer start)" code={curl} />
        </div>
      )}
    </Panel>
  )
}

function StatusBadge({ status }: { status: SellerVerificationStatus | null }) {
  if (!status) return <Badge tone="neutral">Not checked</Badge>
  return status.verified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Not verified yet</Badge>
}

function VerificationPanel({ data }: { data: Promote }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [domains, setDomains] = useState(() => data.domains.map((entry) => entry.domain))
  const [github, setGithub] = useState(() => data.github.map((entry) => ({ username: entry.username, repository: entry.repository })))
  const [newDomain, setNewDomain] = useState('')
  const [newGithub, setNewGithub] = useState('')
  const [saved, setSaved] = useState(false)
  const base = useRef(JSON.stringify([data.domains.map((entry) => entry.domain), data.github.map((entry) => ({ username: entry.username, repository: entry.repository }))]))
  useEffect(() => {
    base.current = JSON.stringify([data.domains.map((entry) => entry.domain), data.github.map((entry) => ({ username: entry.username, repository: entry.repository }))])
  }, [data])
  const changed = JSON.stringify([domains, github]) !== base.current
  const update = (next: Promote) => {
    queryClient.setQueryData(qk.sellerPromote, next)
    setDomains(next.domains.map((entry) => entry.domain))
    setGithub(next.github.map((entry) => ({ username: entry.username, repository: entry.repository })))
  }
  const save = useMutation({
    mutationFn: () => api.seller.saveVerifications({ domains: domains.map((domain) => ({ domain })), github: github.map(({ username, repository }) => (repository && repository.toLowerCase() !== username.toLowerCase() ? { username, repository } : { username })) }),
    onSuccess: (next) => { update(next); setSaved(true); toast('Saved. Restart the seller to announce the claims.') },
  })
  const check = useMutation({ mutationFn: api.seller.checkVerifications, onSuccess: update })
  const readOnly = !data.writable
  const claimFor = (domain: string) => data.domains.find((entry) => entry.domain === domain)
  const githubFor = (username: string) => data.github.find((entry) => entry.username.toLowerCase() === username.toLowerCase())

  return (
    <Panel title="Verify your identity" description="A verified domain or GitHub account shows next to your name and adds up to 20 trust points. Publish the proof, list the claim here, then restart the seller."
      actions={<Button size="sm" variant="outline" disabled={check.isPending || (data.domains.length === 0 && data.github.length === 0)} onClick={() => check.mutate()}>{check.isPending ? 'Checking…' : 'Check now'}</Button>}>
      <div className="gc-stack">
        {readOnly && <p className="gc-seller-notice"><span className="gc-attention" aria-hidden="true" />{data.readOnlyReason}</p>}
        {check.error ? <ErrorAlert error={check.error} title="Could not check" /> : null}
        {domains.map((domain) => {
          const claim = claimFor(domain)
          return (
            <div key={`d:${domain}`} className="gc-seller-claim">
              <div className="gc-seller-claim__head"><span><strong>{domain}</strong> <span className="gc-fineprint">domain</span></span>
                <span className="gc-inline">{claim ? <StatusBadge status={claim.status} /> : <Badge tone="neutral">Unsaved</Badge>}
                  {!readOnly && <Button size="sm" variant="link" onClick={() => setDomains(domains.filter((entry) => entry !== domain))}>Remove</Button>}</span>
              </div>
              {claim?.status && !claim.status.verified && claim.status.error && <p className="gc-fineprint">Last check {formatRelative(claim.status.checkedAt)}: {claim.status.error}</p>}
              {claim && (
                <div className="gc-grid gc-grid--2">
                  <CodeBlock label={`DNS TXT record on ${claim.txtName}`} code={claim.txtValue} />
                  <CodeBlock label={`Or serve ${claim.wellKnownUrl}`} code={claim.wellKnownBody} />
                </div>
              )}
            </div>
          )
        })}
        {github.map((entry) => {
          const claim = githubFor(entry.username)
          return (
            <div key={`g:${entry.username}`} className="gc-seller-claim">
              <div className="gc-seller-claim__head"><span><strong>github.com/{entry.username}</strong> <span className="gc-fineprint">GitHub</span></span>
                <span className="gc-inline">{claim ? <StatusBadge status={claim.status} /> : <Badge tone="neutral">Unsaved</Badge>}
                  {!readOnly && <Button size="sm" variant="link" onClick={() => setGithub(github.filter((item) => item.username !== entry.username))}>Remove</Button>}</span>
              </div>
              {claim?.status && !claim.status.verified && claim.status.error && <p className="gc-fineprint">Last check {formatRelative(claim.status.checkedAt)}: {claim.status.error}</p>}
              {claim && <CodeBlock label={`Commit antseed.json to github.com/${claim.username}/${claim.repository} (public), so it is served at ${claim.proofUrl}`} code={claim.proofBody} />}
            </div>
          )
        })}
        {domains.length === 0 && github.length === 0 && <p className="gc-muted">No claims yet.</p>}
        {!readOnly && (
          <div className="gc-grid gc-grid--2">
            <div className="gc-inline">
              <TextField size="sm" label="Add a domain" placeholder="example.com" value={newDomain} onChange={(event) => setNewDomain(event.target.value)} />
              <Button size="sm" variant="outline" className="gc-seller-inline-button" disabled={!newDomain.trim()} onClick={() => { setDomains([...new Set([...domains, newDomain.trim().toLowerCase()])]); setNewDomain('') }}>Add</Button>
            </div>
            <div className="gc-inline">
              <TextField size="sm" label="Add a GitHub account" placeholder="username or username/repository" value={newGithub} onChange={(event) => setNewGithub(event.target.value)} />
              <Button size="sm" variant="outline" className="gc-seller-inline-button" disabled={!newGithub.trim()} onClick={() => {
                const [username, repository] = newGithub.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//, '').split('/')
                if (username && !github.some((item) => item.username.toLowerCase() === username.toLowerCase())) setGithub([...github, { username, repository: repository || username }])
                setNewGithub('')
              }}>Add</Button>
            </div>
          </div>
        )}
        {saved && !changed && <p className="gc-seller-notice" role="status"><span className="gc-attention" aria-hidden="true" />Saved to config.json. Restart the seller to announce the claims; buyers then check them.</p>}
        {save.error ? <ErrorAlert error={save.error} title="Could not save" /> : null}
        {!readOnly && (
          <div className="gc-actions">
            <span className="gc-fineprint gc-actions__note">{changed ? 'Applies when the seller restarts.' : 'No changes.'}</span>
            <Button disabled={!changed || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          </div>
        )}
      </div>
    </Panel>
  )
}
