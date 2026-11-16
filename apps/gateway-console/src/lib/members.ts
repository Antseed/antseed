import type { Invite, Member } from '../api/types'

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/** Warnings when an invite's name or email matches an existing member or a pending invite. */
export function duplicateInviteWarnings(input: { label: string; email: string }, members: readonly Member[], invites: readonly Invite[]): string[] {
  const out: string[] = []
  const now = Date.now()
  for (const member of members) {
    if (same(member.email, input.email)) out.push(`${member.label} already uses ${member.email}.`)
    else if (same(member.label, input.label)) out.push(`A member named ${member.label} already exists${member.status === 'invited' ? ' (invited, not joined yet)' : ''}.`)
  }
  for (const invite of invites) {
    if (invite.expiresAt < now) continue
    if (same(invite.email, input.email)) out.push(`A pending invite already goes to ${invite.email}.`)
    else if (same(invite.label, input.label)) out.push(`A pending invite for ${invite.label} already exists.`)
  }
  return [...new Set(out)]
}
