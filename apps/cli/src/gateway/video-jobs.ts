import { nativeVideoRoute } from '@antseed/api-adapter'

/** Identifies a video job across its create, polls and delivery. */
export function videoJobKey(protocol: string, jobId: string): string {
  return `${protocol}\n${jobId}`
}

/**
 * The stored reservation of a video create still in flight (or whose job
 * could not be stored yet), keyed apart from every job: no protocol is named
 * `create`.
 */
export function videoReservationKey(tag: string): string {
  return `create\n${tag}`
}

export function isVideoReservationKey(key: string): boolean {
  return key.startsWith('create\n')
}

/** The video job a request row names, keyed like `videoJobKey`, or null for anything else. */
export function requestVideoJob(path: string, jobId: string | null): string | null {
  if (!jobId) return null
  const protocol = nativeVideoRoute({ method: 'POST', path, body: Buffer.alloc(0) })?.protocol
  return protocol ? videoJobKey(protocol, jobId) : null
}
