import { copyText, useToast } from '@antseed/ui'
import { useStatus } from '../lib/queries'
import { gatewayBaseUrl, pinnedModelId } from '../lib/snippets'

/** This gateway's client base URL: its public URL, else the address the console is open on. */
export function useGatewayBaseUrl(): string {
  const status = useStatus()
  return gatewayBaseUrl(status.data?.publicUrl, window.location.origin)
}

/** Copies a value and confirms with a toast. */
export function useCopy() {
  const toast = useToast()
  return async (value: string) => {
    if (await copyText(value)) toast('Copied')
    else toast('Could not copy to the clipboard', 'danger')
  }
}

/** The row-menu item that copies `<peerId>@<model>`. */
export function copyModelIdItem(copy: (value: string) => Promise<void>, peerId: string, model: string) {
  return { label: 'Copy model id', onSelect: () => void copy(pinnedModelId(peerId, model)) }
}
