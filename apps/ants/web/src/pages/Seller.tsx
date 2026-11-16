import { useState } from 'react';
import type { SellerView } from '../../../src/api-types';
import { api } from '../api';
import { useConfig } from '../app-context';
import { AddressLink } from '../components/AddressLink';
import { ActionButton } from '../components/Confirm';
import { Details } from '../components/Details';
import { EpochCell } from '../components/Epoch';
import { ErrorBox, Skeleton } from '../components/Feedback';
import { Input } from '../components/Field';
import { Facts, Panel } from '../components/Panel';
import { Pill } from '../components/Pill';
import { StatTile, Tiles } from '../components/StatTile';
import { OwnSellerStatus, ProofLookup, ProofSubmit, SellerLookup } from '../components/Verification';
import { usePageData } from '../data';
import { formatAnts, formatUsdc, formatInt, isPositiveInt } from '../format';

export function SellerPage() {
  const config = useConfig();
  const disconnected = /^0x0{40}$/i.test(config.address);
  const page = usePageData(disconnected ? null : `seller:${config.address.toLowerCase()}`, api.seller);
  const data = page.data;

  if (disconnected) {
    return (
      <Panel title="Open your seller dashboard">
        <p className="muted">
          Open this dashboard with <code>antseed ants --address 0x...</code> using your seller’s address, then connect that seller’s wallet.
        </p>
      </Panel>
    );
  }
  if (!data) {
    return page.error ? <ErrorBox error={page.error} onRetry={page.refresh} /> : <Skeleton rows={6} />;
  }
  return (
    <>
      {page.error && data ? <div className="status-line">Refresh failed: {page.error}</div> : null}
      {data.agentId === 0 ? (
        <Panel title="Not registered as a seller">
          <p className="muted">
            The connected wallet has no seller identity on this network. Switch to your seller wallet, or register this wallet below to create its identity and bind it in the seller registry.
          </p>
        </Panel>
      ) : null}
      <SellerBody data={data} />

      <Panel title="Wash-trading status">
        <OwnSellerStatus />
      </Panel>

      <Panel className="panel-collapsible">
        <Details summary="Advanced: submit a seller proof">
          <div className="stack-lg">
            <ProofSubmit />
            <div>
              <div className="section-label">Proof status</div>
              <ProofLookup />
            </div>
          </div>
        </Details>
      </Panel>

      <Panel className="panel-collapsible">
        <Details summary="Look up another seller">
          <SellerLookup />
        </Details>
      </Panel>
    </>
  );
}

function YesNo({ value }: { value: boolean | null }) {
  if (value === null) return <span className="muted">n/a</span>;
  return value ? <Pill tone="accent">yes</Pill> : <Pill tone="muted">no</Pill>;
}

function SellerBody({ data }: { data: SellerView }) {
  const starter = data.starter;
  return (
    <>
      <Tiles>
        <StatTile label="Agent id" value={data.agentId || '—'} sub={data.identityRegistered ? 'identity registered' : 'no ERC-8004 identity'} />
        <StatTile label="Eligible" value={data.eligible ? 'yes' : 'no'} sub={data.registryBound ? 'bound in seller registry' : 'not bound'} />
        <StatTile label="Pool active stake" value={formatAnts(data.poolActiveStake)} unit="ANTS" sub={data.minPoolStake !== null ? `min ${formatAnts(data.minPoolStake)} ANTS` : undefined} />
      </Tiles>

      <Panel title="Identity and registry">
        <Facts
          items={[
            ['ERC-8004 identity', <YesNo value={data.identityRegistered} />],
            ['Seller registry binding', <YesNo value={data.registryBound} />],
            ['Legacy stake', `${formatUsdc(data.legacyStake)} USDC`],
            ['Legacy eligibility path', <YesNo value={data.legacyEligibilityEnabled} />],
          ]}
        />
        <div className="mt">
          <RegisterAction data={data} />
        </div>
        <div className="hint mt">
          CLI equivalent: <code>antseed seller register</code>
        </div>
      </Panel>

      <Panel
        title="Starter grant"
        actions={
          starter ? (
            starter.claimable ? (
              <Pill tone="accent">claimable</Pill>
            ) : starter.expired ? (
              <Pill tone="muted">expired</Pill>
            ) : starter.initialized ? (
              <Pill tone="amber">initialized</Pill>
            ) : (
              <Pill tone="muted">not initialized</Pill>
            )
          ) : null
        }
      >
        {starter ? (
          <>
            <Facts
              items={[
                ['Grants remaining', formatInt(starter.remaining)],
                ['Grant amount', `${formatAnts(starter.amount, 4)} ANTS`],
                ['Claim window ends', <EpochCell epoch={starter.endEpoch} />],
                ['Legacy eligible', <YesNo value={starter.legacyEligible} />],
              ]}
            />
            <div className="mt">
              <ActionButton
                label={starter.initialized ? 'Grant already claimed' : 'Claim starter'}
                variant="primary"
                title="Claim starter grant"
                path="/api/seller/claim-starter"
                body={{}}
                disabled={starter.initialized || !starter.claimable}
                disabledReason={starter.initialized ? 'This starter grant has already been claimed.' : starter.expired ? 'The starter grant window has expired.' : 'The starter grant is not claimable for this wallet.'}
              />
            </div>
            <Details summary="Details" className="mt">
              <Facts
                items={[
                  ['Contract', starter.contract ? <AddressLink value={starter.contract} short={false} /> : '—'],
                  ['Initialized', <YesNo value={starter.initialized} />],
                  ['Expired', <YesNo value={starter.expired} />],
                ]}
              />
              <div className="hint mt">
                CLI equivalent: <code>antseed seller legacy claim-starter</code>
              </div>
            </Details>
          </>
        ) : (
          <span className="muted">No starter grant contract on this chain.</span>
        )}
      </Panel>
    </>
  );
}

function RegisterAction({ data }: { data: SellerView }) {
  const [agentId, setAgentId] = useState(data.agentId > 0 ? String(data.agentId) : '');
  const body: { agentId?: number } = agentId.trim() ? { agentId: Number(agentId) } : {};
  return (
    <div className="form-row">
      <Input label="Agent id (optional)" hint="Use an existing ID, or leave empty to create an identity if this wallet has none." width="md" inputMode="numeric" value={agentId} onChange={(e) => setAgentId(e.target.value)} />
      <ActionButton
        label={data.registryBound ? 'Re-register binding' : 'Register binding'}
        variant="primary"
        title="Register seller binding"
        path="/api/seller/register"
        body={body}
        validate={() => (agentId.trim() && !isPositiveInt(agentId) ? 'Agent id must be a positive integer.' : null)}
      />
      <p className="hint mt">Binds this wallet to its agent id in the seller registry. Without an id, it reuses a known identity or creates one if this wallet has none. Creating and binding can require separate transactions.</p>
    </div>
  );
}
