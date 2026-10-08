import { useState } from 'react'
import { Button, Modal } from '@antseed/ui'
import type { ApiKey } from '../api/types'
import { gatewayBaseUrl, keySnippets } from '../lib/snippets'
import { useStatus } from '../lib/queries'
import { CodeBlock, SecretReveal, Tabs } from './ui'

/** Shows a new or rotated key's secret once, with ready-to-paste client snippets. */
export function KeySecretModal({ result, onClose }: { result: { key: ApiKey; secret: string } | null; onClose: () => void }) {
  const status = useStatus()
  const [tab, setTab] = useState<string>('curl')
  const baseUrl = gatewayBaseUrl(status.data?.publicUrl, window.location.origin)
  const snippets = result ? keySnippets(baseUrl, result.secret) : []
  const snippet = snippets.find((entry) => entry.id === tab)
  return (
    <Modal isOpen={result !== null} onClose={onClose} size="lg" eyebrow="API key" title={result ? `${result.key.label} is ready` : ''}>
      {result && (
        <div className="gc-stack">
          <SecretReveal secret={result.secret} />
          <div>
            <div className="as-field__label">Use it</div>
            <p className="gc-muted">Base URL <code>{baseUrl}/v1</code>. Replace <code>&lt;model&gt;</code> with a model from the Network page.</p>
          </div>
          <Tabs value={tab} onChange={setTab} tabs={snippets.map((entry) => ({ id: entry.id, label: entry.label }))} />
          {snippet && <CodeBlock code={snippet.code} />}
          <div className="gc-actions"><Button onClick={onClose}>Done</Button></div>
        </div>
      )}
    </Modal>
  )
}
