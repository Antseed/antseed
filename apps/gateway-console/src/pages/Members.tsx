import { useState } from 'react'
import { Alert, Button, DataTable, Modal, TextField, useToast } from '@antseed/ui'
import { api, errorMessage } from '../api'
import type { Invite, InviteInput, Member, OrgRole, WorkspaceRole } from '../api/types'
import { useConsole } from '../app/context'
import { usePolicySaveGuard } from '../components/PolicySaveGuard'
import { Icon } from '../components/icons'
import { LimitsEditor } from '../components/LimitsEditor'
import { PolicyFieldset, usePolicyDraft } from '../components/PolicyField'
import {
  Badge, ConfirmDialog, CopyButton, EmptyState, ErrorAlert, Expiry, PageHeader, Panel, QueryView, SecretReveal, SelectField,
} from '../components/ui'
import { describeLimits, formatDate, formatRelative } from '../lib/format'
import { draftToLimits, limitsToDraft } from '../lib/limits'
import { useConsoleMutation } from '../lib/mutations'
import { isOrgAdmin, ROLE_LABELS } from '../lib/nav'
import { describePolicy } from '../lib/policy'
import { qk, useInvites, useMembers, useWorkspaceMembers } from '../lib/queries'
import { duplicateInviteWarnings } from '../lib/members'

/** Everything a member, invite or workspace-membership change can affect. */
const MEMBER_GROUPS = [qk.group('members'), qk.group('workspaces'), qk.group('keys')]
const INVITE_GROUPS = [...MEMBER_GROUPS, qk.group('invites')]

const WORKSPACE_ROLE_OPTIONS = [{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]

function statusBadge(member: Member) {
  if (member.status === 'disabled') return <Badge tone="danger">Disabled</Badge>
  if (member.status === 'invited') return <Badge tone="warning">Invited</Badge>
  return <Badge tone="success">Active</Badge>
}

/** Organization roles the viewer may hand out: owners any, org admins up to admin, others member only. */
function assignableRoles(myRole: OrgRole, orgAdmin: boolean): OrgRole[] {
  if (myRole === 'owner') return ['member', 'admin', 'owner']
  if (orgAdmin) return ['member', 'admin']
  return ['member']
}

function roleOptions(roles: OrgRole[]) {
  return roles.map((role) => ({ value: role, label: ROLE_LABELS[role] }))
}

function InviteForm({ onCreated, onCancel }: { onCreated: (invite: Invite) => void; onCancel: () => void }) {
  const { me, viewer, workspace } = useConsole()
  const orgAdmin = isOrgAdmin(viewer)
  const adminWorkspaces = me.workspaces.filter((entry) => orgAdmin || entry.role === 'admin').map((entry) => entry.workspace)
  const [label, setLabel] = useState('')
  const [email, setEmail] = useState('')
  const [orgRole, setOrgRole] = useState<OrgRole>('member')
  const [hours, setHours] = useState('72')
  const [workspaces, setWorkspaces] = useState<Record<string, WorkspaceRole | ''>>({ [workspace.id]: 'member' })
  const members = useMembers(orgAdmin)
  const invites = useInvites()
  const duplicates = duplicateInviteWarnings({ label, email }, members.data ?? [], invites.data ?? [])
  const create = useConsoleMutation({
    mutationFn: () => {
      const input: InviteInput = {
        label: label.trim(),
        email: email.trim() || null,
        orgRole,
        workspaces: Object.entries(workspaces).filter(([, role]) => role).map(([workspaceId, role]) => ({ workspaceId, role: role as WorkspaceRole })),
        expiresInHours: Number(hours) || 72,
      }
      return api.invites.create(input)
    },
    onSuccess: onCreated,
    invalidate: INVITE_GROUPS,
  })
  const idleLabel = duplicates.length ? 'Create anyway' : 'Create invite link'
  return (
    <form className="gc-stack" onSubmit={(event) => { event.preventDefault(); create.mutate() }}>
      <div className="gc-grid gc-grid--2">
        <TextField label="Name" required value={label} onChange={(event) => setLabel(event.target.value)} />
        <TextField label="Email (optional)" type="email" value={email} onChange={(event) => setEmail(event.target.value)}
          hint="Required when they will sign in with your identity provider." />
      </div>
      <div className="gc-grid gc-grid--2">
        <SelectField label="Organization role" value={orgRole} onChange={(value) => setOrgRole(value as OrgRole)}
          options={roleOptions(assignableRoles(me.member.orgRole, orgAdmin))}
          hint={orgRole === 'member' ? 'Sees only the workspaces below.' : 'Can manage every workspace.'} />
        <SelectField label="Link expires after" value={hours} onChange={setHours}
          options={[{ value: '24', label: '1 day' }, { value: '72', label: '3 days' }, { value: '168', label: '7 days' }]} />
      </div>
      <fieldset className="gc-checks">
        <legend className="as-field__label">Workspaces</legend>
        {adminWorkspaces.map((ws) => (
          <div key={ws.id} className="gc-inline gc-inline--between">
            <span>{ws.name}</span>
            <SelectField aria-label={`Role in ${ws.name}`} value={workspaces[ws.id] ?? ''} onChange={(value) => setWorkspaces({ ...workspaces, [ws.id]: value as WorkspaceRole | '' })}
              options={[{ value: '', label: 'No access' }, ...WORKSPACE_ROLE_OPTIONS]} />
          </div>
        ))}
      </fieldset>
      {duplicates.length > 0 && (
        <Alert tone="warning" title="Possible duplicate">
          <ul className="gc-list">{duplicates.map((text) => <li key={text}>{text}</li>)}</ul>
        </Alert>
      )}
      {create.error ? <ErrorAlert error={create.error} title="Could not create the invite" /> : null}
      <div className="gc-actions">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={create.isPending || !label.trim()}>{create.isPending ? 'Creating…' : idleLabel}</Button>
      </div>
    </form>
  )
}

function MemberForm({ member, onDone }: { member: Member; onDone: () => void }) {
  const { me, viewer } = useConsole()
  const orgAdmin = isOrgAdmin(viewer)
  const [label, setLabel] = useState(member.label)
  const [email, setEmail] = useState(member.email ?? '')
  const [orgRole, setOrgRole] = useState<OrgRole>(member.orgRole)
  const [limits, setLimits] = useState(limitsToDraft(member.limits))
  const [maxKeys, setMaxKeys] = useState(member.maxKeys === null ? '' : String(member.maxKeys))
  const policy = usePolicyDraft(member.routingPolicy)
  const [removing, setRemoving] = useState<Member['credentials'][number] | null>(null)
  const [toggling, setToggling] = useState(false)

  const guard = usePolicySaveGuard()
  const save = useConsoleMutation({
    mutationFn: async () => {
      const keys = maxKeys.trim() === '' ? null : Number(maxKeys)
      if (keys !== null && (!Number.isInteger(keys) || keys < 0)) throw new Error('Key limit must be a whole number.')
      const input = {
        label: label.trim(), email: email.trim() || null, limits: draftToLimits(limits), maxKeys: keys,
        routingPolicy: policy.build(), ...(orgAdmin ? { orgRole } : {}),
      }
      return guard.save([input.routingPolicy], (options) => api.members.update(member.id, input, options))
    },
    onSuccess: onDone,
    invalidate: MEMBER_GROUPS,
    toast: 'Member saved',
  })
  const toggle = useConsoleMutation({
    mutationFn: () => (member.status === 'disabled' ? api.members.enable(member.id) : api.members.disable(member.id)),
    onSuccess: () => { setToggling(false); onDone() },
    invalidate: MEMBER_GROUPS,
  })
  const removeCredential = useConsoleMutation({
    mutationFn: (credentialId: string) => api.members.removeCredential(member.id, credentialId),
    onSuccess: () => { setRemoving(null); onDone() },
    invalidate: MEMBER_GROUPS,
  })
  const self = member.id === me.member.id
  const disabled = member.status === 'disabled'
  // Only an owner may change an owner (profile, status, sign-in methods).
  const canManage = orgAdmin && (member.orgRole !== 'owner' || me.member.orgRole === 'owner')
  // Your own last sign-in method cannot be removed (409 last_credential).
  const lastOwnCredential = self && member.credentials.length <= 1

  return (
    <form className="gc-stack" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
      <div className="gc-grid gc-grid--2">
        <TextField label="Name" value={label} onChange={(event) => setLabel(event.target.value)} />
        <TextField label="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </div>
      <div className="gc-grid gc-grid--2">
        {orgAdmin && (
          <SelectField label="Organization role" value={orgRole} disabled={self || (member.orgRole === 'owner' && me.member.orgRole !== 'owner')}
            onChange={(value) => setOrgRole(value as OrgRole)} options={roleOptions(assignableRoles(me.member.orgRole, true))} />
        )}
        <TextField label="Keys they may create" inputMode="numeric" placeholder="No limit" value={maxKeys} onChange={(event) => setMaxKeys(event.target.value)} />
      </div>
      <div>
        <div className="as-field__label gc-label-row">Spend limits across their keys (USD)</div>
        <LimitsEditor idPrefix="member-limit" value={limits} onChange={setLimits} />
      </div>
      <PolicyFieldset draft={policy.draft} setDraft={policy.setDraft} />

      <div>
        <div className="as-field__label gc-label-row">Sign-in methods</div>
        {member.credentials.length === 0 ? <p className="gc-muted">None yet.</p> : (
          <ul className="gc-list">
            {member.credentials.map((credential) => (
              <li key={credential.id} className="gc-inline gc-inline--between">
                <span><Badge>{credential.kind}</Badge> {credential.label} <span className="gc-muted">· last used {formatRelative(credential.lastUsedAt)}</span></span>
                {canManage && (
                  <Button variant="ghost" size="sm" disabled={lastOwnCredential} title={lastOwnCredential ? 'Add another sign-in method first' : undefined}
                    onClick={() => setRemoving(credential)}>Remove</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {!canManage && <Alert tone="info">Only an owner can change an owner's profile, status or sign-in methods.</Alert>}
      {save.error ? <ErrorAlert error={save.error} title="Could not save" /> : null}
      <div className="gc-actions gc-actions--split">
        {canManage && !self ? (
          <Button variant={disabled ? 'outline' : 'danger'} size="sm" onClick={() => setToggling(true)}>
            {disabled ? 'Enable member' : 'Disable member'}
          </Button>
        ) : <span />}
        <div className="gc-actions">
          <Button variant="ghost" onClick={onDone}>Cancel</Button>
          {canManage && <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>}
        </div>
      </div>

      <ConfirmDialog isOpen={toggling} busy={toggle.isPending} error={toggle.error} onClose={() => setToggling(false)} onConfirm={() => toggle.mutate()}
        title={disabled ? 'Enable this member?' : 'Disable this member?'}
        tone={disabled ? 'primary' : 'danger'}
        confirmLabel={disabled ? 'Enable' : 'Disable'}
        body={disabled ? `${member.label} can sign in again. Their revoked keys stay revoked.` : `${member.label} is signed out and all of their keys are revoked.`} />
      <ConfirmDialog isOpen={removing !== null} busy={removeCredential.isPending} error={removeCredential.error}
        onClose={() => setRemoving(null)} onConfirm={() => removing && removeCredential.mutate(removing.id)}
        title="Remove this sign-in method?" confirmLabel="Remove"
        body={`${removing?.label ?? ''} can no longer be used to sign in as ${member.label}.`} />
      {guard.dialog}
    </form>
  )
}

function WorkspaceRoleCell({ member, role }: { member: Member; role: WorkspaceRole }) {
  const { workspace, me } = useConsole()
  const toast = useToast()
  const update = useConsoleMutation({
    mutationFn: (next: WorkspaceRole) => api.workspaces.setMember(workspace.id, member.id, next),
    invalidate: member.id === me.member.id ? [qk.workspaceMembers(workspace.id), qk.me] : [qk.workspaceMembers(workspace.id)],
    toast: (_, next) => `${member.label} is now a workspace ${next}`,
    onError: (cause) => toast(`Could not change ${member.label}'s role: ${errorMessage(cause)}`, 'danger'),
  })
  // Org admins administer every workspace; their workspace role does not change what they can do.
  const orgLevel = member.orgRole !== 'member'
  return (
    <div onClick={(event) => event.stopPropagation()}>
      <SelectField size="sm" aria-label={`Workspace role for ${member.label}`} value={role} disabled={update.isPending || orgLevel}
        title={orgLevel ? 'Organization admins administer every workspace' : undefined}
        onChange={(value) => update.mutate(value as WorkspaceRole)}
        options={WORKSPACE_ROLE_OPTIONS} />
    </div>
  )
}

function OrgMembersPanel({ onEdit }: { onEdit: (member: Member) => void }) {
  const members = useMembers()
  return (
    <Panel flush title="Everyone in the organization">
      <QueryView query={members}>
        {(rows) => (
          <DataTable<Member> label="All members" rows={rows} rowKey={(member) => member.id} onRowClick={onEdit} rowLabel={(member) => member.label}
            actions={(member) => [{ label: 'Edit member', onSelect: () => onEdit(member) }]}
            columns={[
              { key: 'name', header: 'Name', sortValue: (member) => member.label, render: (member) => (
                <span className="gc-strong">{member.label}{member.status !== 'active' && <span className="gc-narrow-only"> {statusBadge(member)}</span>}</span>
              ) },
              { key: 'email', header: 'Email', secondary: true, render: (member) => member.email ?? '—' },
              { key: 'role', header: 'Role', render: (member) => ROLE_LABELS[member.orgRole] },
              { key: 'keys', header: 'Key limit', secondary: true, optional: true, render: (member) => member.maxKeys ?? 'No limit' },
              { key: 'since', header: 'Joined', secondary: true, sortValue: (member) => member.createdAt,
                render: (member) => member.status === 'invited' ? <span className="gc-muted">Invited {formatDate(member.createdAt)}</span> : formatDate(member.createdAt) },
              { key: 'status', header: 'Status', secondary: true, render: statusBadge },
            ]} />
        )}
      </QueryView>
    </Panel>
  )
}

function InvitesPanel() {
  const invites = useInvites()
  const [revoking, setRevoking] = useState<Invite | null>(null)
  const revoke = useConsoleMutation({
    mutationFn: (invite: Invite) => api.invites.revoke(invite.id),
    onSuccess: () => setRevoking(null),
    invalidate: INVITE_GROUPS,
  })
  return (
    <Panel flush title="Pending invites">
      <QueryView query={invites}>
        {(rows) => (
          <DataTable<Invite> label="Pending invites" rows={rows} rowKey={(invite) => invite.id} rowLabel={(invite) => `invite for ${invite.label}`}
            empty={<EmptyState icon={<Icon.members size={18} />} title="No pending invites" />}
            actions={(invite) => [{ label: 'Revoke invite', tone: 'danger' as const, onSelect: () => setRevoking(invite) }]}
            columns={[
              { key: 'name', header: 'Name', render: (invite) => <span className="gc-strong">{invite.label}</span> },
              { key: 'email', header: 'Email', secondary: true, render: (invite) => invite.email ?? '—' },
              { key: 'role', header: 'Role', render: (invite) => ROLE_LABELS[invite.orgRole] },
              { key: 'expires', header: 'Expires', secondary: true, render: (invite) => <Expiry at={invite.expiresAt} format={formatRelative} /> },
            ]} />
        )}
      </QueryView>
      <ConfirmDialog isOpen={revoking !== null} busy={revoke.isPending} error={revoke.error}
        onClose={() => setRevoking(null)} onConfirm={() => revoking && revoke.mutate(revoking)}
        title="Revoke this invite?" confirmLabel="Revoke" body="The link stops working." />
    </Panel>
  )
}

/** The new invite's link, shown once. */
function InviteLinkModal({ invite, onClose }: { invite: Invite | null; onClose: () => void }) {
  return (
    <Modal isOpen={invite !== null} onClose={onClose} title="Invite link" size="lg">
      {invite && (
        <div className="gc-stack">
          {invite.url ? (
            <>
              <p>Send this link to <strong>{invite.label}</strong>. It works once and expires {formatRelative(invite.expiresAt)}.</p>
              <SecretReveal secret={invite.url} note="This link is shown only once. Anyone with it can join as this member." />
            </>
          ) : <Alert tone="warning">The gateway did not return a link for this invite.</Alert>}
          <div className="gc-actions">{invite.url && <CopyButton value={invite.url} label="Copy link" size="md" />}<Button onClick={onClose}>Done</Button></div>
        </div>
      )}
    </Modal>
  )
}

export default function Members() {
  const { viewer, workspace, me } = useConsole()
  const orgAdmin = isOrgAdmin(viewer)
  const [inviting, setInviting] = useState(false)
  const [created, setCreated] = useState<Invite | null>(null)
  const [editing, setEditing] = useState<Member | null>(null)
  const [removing, setRemoving] = useState<Member | null>(null)
  const [adding, setAdding] = useState('')
  const wsMembers = useWorkspaceMembers(workspace.id)
  const allMembers = useMembers(orgAdmin)

  const removeFromWorkspace = useConsoleMutation({
    mutationFn: (member: Member) => api.workspaces.removeMember(workspace.id, member.id),
    onSuccess: () => setRemoving(null),
    invalidate: INVITE_GROUPS,
    toast: 'Removed from workspace',
  })
  const addMember = useConsoleMutation({
    mutationFn: (memberId: string) => api.workspaces.setMember(workspace.id, memberId, 'member'),
    onSuccess: () => setAdding(''),
    invalidate: INVITE_GROUPS,
    toast: 'Added to workspace',
  })
  const inWorkspace = new Set(wsMembers.data?.map(({ member }) => member.id))
  const addable = (allMembers.data ?? []).filter((member) => !inWorkspace.has(member.id) && member.status === 'active')

  return (
    <div className="gc-page">
      <PageHeader title="Members" description="Who can use this gateway, their budgets and routing."
        actions={<Button leadingIcon={<Icon.plus size={14} />} onClick={() => setInviting(true)}>Invite member</Button>} />

      <Panel flush title={`${workspace.name} workspace`} actions={orgAdmin && addable.length > 0 ? (
        <div className="gc-inline">
          <SelectField size="sm" aria-label="Add an existing member" value={adding} onChange={setAdding}
            options={[{ value: '', label: 'Add existing member…' }, ...addable.map((member) => ({ value: member.id, label: member.label }))]} />
          <Button size="sm" variant="outline" disabled={!adding || addMember.isPending} onClick={() => addMember.mutate(adding)}>Add</Button>
        </div>
      ) : undefined}>
        <QueryView query={wsMembers}>
          {(rows) => (
            <DataTable label="Workspace members" rows={rows} rowKey={(row) => row.member.id}
              onRowClick={orgAdmin ? (row) => setEditing(row.member) : undefined} rowLabel={(row) => row.member.label}
              actions={(row) => [
                orgAdmin && { label: 'Edit member', onSelect: () => setEditing(row.member) },
                row.member.id !== me.member.id && { label: 'Remove from workspace', tone: 'danger' as const, onSelect: () => setRemoving(row.member) },
              ]}
              empty={<EmptyState icon={<Icon.members size={18} />} title="No members in this workspace" />}
              columns={[
                { key: 'name', header: 'Name', sortValue: (row) => row.member.label, render: (row) => (
                  <div><div className="gc-strong">{row.member.label}</div><div className="gc-muted">{row.member.email ?? ROLE_LABELS[row.member.orgRole]}</div></div>
                ) },
                { key: 'role', header: 'Workspace role', render: (row) => <WorkspaceRoleCell member={row.member} role={row.role} /> },
                { key: 'limits', header: 'Limits', secondary: true, optional: true, render: (row) => <span className="gc-muted">{describeLimits(row.member.limits)}</span> },
                { key: 'policy', header: 'Routing', secondary: true, optional: true, render: (row) => <span className="gc-muted">{describePolicy(row.member.routingPolicy)}</span> },
                { key: 'status', header: 'Status', secondary: true, render: (row) => statusBadge(row.member) },
              ]} />
          )}
        </QueryView>
      </Panel>

      {orgAdmin && <OrgMembersPanel onEdit={setEditing} />}

      <InvitesPanel />

      <Modal isOpen={inviting} onClose={() => setInviting(false)} size="lg" title="Invite a member">
        {inviting && <InviteForm onCancel={() => setInviting(false)} onCreated={(invite) => { setInviting(false); setCreated(invite) }} />}
      </Modal>
      <InviteLinkModal invite={created} onClose={() => setCreated(null)} />
      <Modal isOpen={editing !== null} onClose={() => setEditing(null)} size="lg" title={editing?.label ?? ''} eyebrow="Member">
        {editing && <MemberForm key={editing.id} member={editing} onDone={() => setEditing(null)} />}
      </Modal>
      <ConfirmDialog isOpen={removing !== null} busy={removeFromWorkspace.isPending} error={removeFromWorkspace.error}
        onClose={() => setRemoving(null)} onConfirm={() => removing && removeFromWorkspace.mutate(removing)}
        title="Remove from workspace?" confirmLabel="Remove"
        body={`${removing?.label ?? ''} loses access to ${workspace.name}. Their keys in this workspace stop working.`} />
    </div>
  )
}
