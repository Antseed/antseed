import { useEffect, useRef, useState } from 'react';
import { MAX_BUILDER_AGENTS } from '../../../src/api-types';
import type { BuildersView, JobView } from '../../../src/api-types';
import { api } from '../api';
import { useConfig } from '../app-context';
import { AddressLink } from '../components/AddressLink';
import { ActionButton } from '../components/Confirm';
import { ErrorBox } from '../components/Feedback';
import { Input } from '../components/Field';
import { Button, Card } from '../components/ui';
import { usePageData } from '../data';
import { formatAnts, isZero, sumBig } from '../format';
import { useJobList } from '../jobs';
import { BucketRow, RewardAmount } from './reward-rows';

const BUILDER_IDS_KEY = 'antseed.ants.builderAgentIds';
const FIRST_PARTY_NAMES = { cli: 'Antseed CLI', desktop: 'Antseed Desktop' } as const;

/** Client agent ids the user added, per chain. Storage can be unavailable; then the list lives for this page only. */
function readBuilderIds(chainId: string): number[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(`${BUILDER_IDS_KEY}:${chainId}`) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

function writeBuilderIds(chainId: string, ids: number[]): void {
  try {
    window.localStorage.setItem(`${BUILDER_IDS_KEY}:${chainId}`, JSON.stringify(ids));
  } catch {
    /* storage unavailable */
  }
}

const HANDLED_REGISTER_JOBS_KEY = 'antseed.ants.handledBuilderRegisterJobs';
const MAX_HANDLED_REGISTER_JOBS = 100;
/**
 * Register jobs whose agent was already added. The job list outlives the
 * card (and, from the server journal, a reload), so this lives outside the
 * component and in storage; otherwise a removed agent comes back on return.
 */
const handledRegisterJobs = new Set<string>(readHandledRegisterJobs());

function readHandledRegisterJobs(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(HANDLED_REGISTER_JOBS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Agents from newly finished register jobs that are not tracked yet, marking
 * those jobs handled (once ever, so Remove sticks). Agents past the tracking
 * limit come back as `untracked` instead, for the card to name. Null when
 * nothing changes.
 */
export function takeRegisteredAgents(jobs: JobView[], ids: number[]): { ids: number[]; untracked: number[] } | null {
  const finished = jobs.filter((job) => job.kind === 'builder-register' && job.status === 'done');
  if (!finished.length) return null;
  for (const id of readHandledRegisterJobs()) handledRegisterJobs.add(id); // another tab may have handled some
  const registered: number[] = [];
  let handled = false;
  for (const job of finished) {
    if (handledRegisterJobs.has(job.id)) continue;
    handledRegisterJobs.add(job.id);
    handled = true;
    const agentId = (job.result as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId === 'number' && !ids.includes(agentId) && !registered.includes(agentId)) registered.push(agentId);
  }
  if (handled) {
    try {
      window.localStorage.setItem(HANDLED_REGISTER_JOBS_KEY, JSON.stringify([...handledRegisterJobs].slice(-MAX_HANDLED_REGISTER_JOBS)));
    } catch {
      /* storage unavailable: the in-memory set still covers this page load */
    }
  }
  if (!registered.length) return null;
  const room = Math.max(0, MAX_BUILDER_AGENTS - ids.length);
  return { ids: [...ids, ...registered.slice(0, room)], untracked: registered.slice(room) };
}

/** Why Add is off at the tracking limit, which the builders read shares. */
export const BUILDER_LIMIT_HINT = `Up to ${MAX_BUILDER_AGENTS} client agents can be tracked. Remove one to add another.`;

/**
 * Tracked ids the builders response left out (past the limit in a list saved
 * before it was enforced, or not returned): each still gets a row with Remove.
 */
export function missingBuilderIds(ids: number[], view: BuildersView): number[] {
  const shown = new Set(view.agents.map((agent) => agent.agentId));
  return ids.filter((id) => !shown.has(id));
}

/**
 * Builders program: emission rewards for apps built on Antseed, per client
 * ERC-8004 agent. No cheap on-chain lookup lists the agents a wallet owns, so
 * the user adds ids here (remembered per chain); the server adds the chain's
 * first-party client ids this wallet owns.
 */
export function BuildersCard() {
  const dashboard = useConfig();
  const jobs = useJobList();
  const [ids, setIds] = useState(() => readBuilderIds(dashboard.chainId));
  const [draft, setDraft] = useState('');
  const [untracked, setUntracked] = useState<number[]>([]);
  // One read covers the first MAX_BUILDER_AGENTS ids in tracked order; any past it still get a row below.
  const requested = ids.slice(0, MAX_BUILDER_AGENTS);
  const page = usePageData(`builders:${dashboard.chainId}:${[...requested].sort((a, b) => a - b).join(',')}`, () => api.builders(requested), 60_000);
  // Keep the last list on screen while a changed id set loads.
  const lastView = useRef(page.data);
  if (page.data) lastView.current = page.data;
  const view = page.data ?? lastView.current;

  const save = (next: number[]) => { setIds(next); writeBuilderIds(dashboard.chainId, next); };
  // A client agent registered from this card starts tracked (once per job, so Remove sticks).
  useEffect(() => {
    const next = takeRegisteredAgents(jobs, ids);
    if (!next) return;
    if (next.ids.length !== ids.length) save(next.ids);
    if (next.untracked.length) setUntracked((current) => [...new Set([...current, ...next.untracked])]);
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  if (view && !view.available) return null;
  const draftId = Number(draft.trim());
  const draftValid = draft.trim() !== '' && Number.isSafeInteger(draftId) && draftId > 0;
  const atLimit = ids.length >= MAX_BUILDER_AGENTS;
  const add = () => { if (draftValid && !atLimit && !ids.includes(draftId)) save([...ids, draftId]); setDraft(''); };
  const remove = (agentId: number) => save(ids.filter((id) => id !== agentId));
  // Only against the response for the current id set, so a newly added id does not flash as missing.
  const missing = page.data ? missingBuilderIds(ids, page.data) : [];
  return (
    <Card className="hero" aria-label="Builders program">
      <div className="tile-label">Builders program</div>
      <p className="hint">Built an app on Antseed? Register it as a client agent, send its id with settlements, and earn a weekly share of the builders bucket.</p>
      {page.error ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      {view ? <>
        <div className="hero-value"><RewardAmount>{formatAnts(sumBig(view.agents.filter((agent) => agent.owned).map((agent) => agent.payable)), 4)}</RewardAmount><span className="unit">ANTS</span></div>
        <p className="hero-sub muted">Payable now to this wallet</p>
        <div className="buckets">
          {view.agents.map((agent) => {
            const epochs = agent.claimableEpochs.length;
            const name = agent.firstParty ? `${FIRST_PARTY_NAMES[agent.firstParty]} · agent #${agent.agentId}` : `Agent #${agent.agentId}`;
            return (
              <BucketRow key={agent.agentId} visible name={name} amount={agent.payable}
                amountDetail={epochs > 0 ? `${epochs} ${epochs === 1 ? 'week' : 'weeks'} payable` : undefined}
                note={agent.owner
                  ? <>Paid to {agent.owned ? 'this wallet' : <AddressLink value={agent.owner} />}. {epochs > 1 ? 'Each week is its own claim transaction.' : epochs === 0 ? 'Weeks become claimable once they end.' : ''}</>
                  : 'Not a registered ERC-8004 agent on this chain.'}
                actions={<>
                  <ActionButton label="Claim" title={`Claim builder rewards · agent #${agent.agentId}`} path="/api/builders/claim" body={{ agentId: agent.agentId }}
                    disabled={dashboard.readOnly || !agent.owner || !agent.owned || isZero(agent.payable)}
                    disabledReason={dashboard.readOnly ? 'Connect a wallet with a signer to claim.' : !agent.owner ? 'This agent id is not registered.' : !agent.owned ? 'Only the agent owner can claim.' : 'Nothing to claim yet.'}
                    summary={[['Payable now', `${formatAnts(agent.payable, 4)} ANTS`], ['Weeks', String(epochs)]]} />
                  {ids.includes(agent.agentId) ? <Button variant="outline" size="sm" onClick={() => remove(agent.agentId)}>Remove</Button> : null}
                </>} />
            );
          })}
          {missing.map((agentId) => (
            <BucketRow key={agentId} visible name={`Agent #${agentId}`} amount={null}
              note={ids.indexOf(agentId) >= MAX_BUILDER_AGENTS ? `Data unavailable: only the first ${MAX_BUILDER_AGENTS} tracked agents are read.` : 'Data unavailable.'}
              actions={<Button variant="outline" size="sm" onClick={() => remove(agentId)}>Remove</Button>} />
          ))}
          {view.agents.length === 0 && missing.length === 0 ? <p className="hint">Add your app&apos;s client agent id to see its rewards.</p> : null}
        </div>
        <div className="form-row">
          <Input label="Client agent id" width="sm" inputMode="numeric" value={draft}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          <span className="btn-wrap" title={atLimit ? BUILDER_LIMIT_HINT : undefined}>
            <Button variant="outline" size="sm" onClick={add} disabled={!draftValid || atLimit}>Add</Button>
          </span>
          <ActionButton label="Register client agent" title="Register client agent" path="/api/builders/register" body={{}}
            disabled={dashboard.readOnly} disabledReason="Connect a wallet with a signer to register." />
        </div>
        {untracked.length ? <p className="hint">Registered {untracked.map((id) => `agent #${id}`).join(', ')} but not tracked. {BUILDER_LIMIT_HINT}</p>
          : atLimit ? <p className="hint">{BUILDER_LIMIT_HINT}</p>
            : <p className="hint">Track any client agent id; claims always pay its owner.</p>}
      </> : null}
    </Card>
  );
}
