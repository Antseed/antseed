import { useState, type ReactNode } from 'react'
import { apiCallTabs, API_KEY_ENV, type ApiFormat, type ConnectTabId } from '../lib/snippets'
import { useGatewayBaseUrl } from './copy-actions'
import { CodeBlock, PageLink, TabPanel, Tabs } from './ui'

/**
 * A ready-to-run request for `model` through this gateway: curl, Python and
 * JavaScript (OpenAI SDK), plus the Anthropic SDK for Messages models. The
 * key is `$ANTSEED_API_KEY`, never a real secret.
 */
export function ApiCall({ model, format, id = 'gc-api-call', unsupported }: {
  model: string
  format: ApiFormat | null
  /** Base id for the tabs; unique per page. */
  id?: string
  /** Shown instead of the snippets when `format` is null. */
  unsupported?: ReactNode
}) {
  const baseUrl = useGatewayBaseUrl()
  const [tab, setTab] = useState<ConnectTabId>('curl')
  if (!format) return <p className="gc-fineprint">{unsupported ?? 'The gateway does not serve this model through its API.'}</p>
  const tabs = apiCallTabs(baseUrl, model, format)
  const current = tabs.find((entry) => entry.id === tab) ?? tabs[0]!
  return (
    <div className="gc-stack gc-stack--tight">
      <Tabs id={id} label="Request examples" value={current.id} onChange={setTab} className="gc-connect-tabs"
        tabs={tabs.map((entry) => ({ id: entry.id, label: entry.label }))} />
      <TabPanel tabsId={id} tab={current.id}>
        <CodeBlock code={current.code} label={current.label} />
      </TabPanel>
      <p className="gc-fineprint">Set <code>{API_KEY_ENV}</code> to one of your API keys first. <PageLink to="keys">API keys</PageLink></p>
    </div>
  )
}
