import { CopyButton } from '@antseed/ui'
import { gatewayApiUrl } from '../lib/snippets'
import { useGatewayBaseUrl } from './copy-actions'

/**
 * This gateway's OpenAI-compatible base URL with a copy button, in the top
 * bar of every page: what clients and SDKs are pointed at.
 */
export function GatewayEndpoint({ className }: { className?: string }) {
  const url = gatewayApiUrl(useGatewayBaseUrl())
  return (
    <div className={['gc-endpoint', className].filter(Boolean).join(' ')} title={`OpenAI-compatible base URL: ${url}`}>
      <span className="gc-endpoint__label">API</span>
      <code className="gc-endpoint__url">{url}</code>
      <CopyButton iconOnly value={url} label="Copy the gateway API URL" className="gc-endpoint__copy" />
    </div>
  )
}
