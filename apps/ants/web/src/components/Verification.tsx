import { Button } from './ui';
import { useState, type ChangeEvent, type ReactNode } from 'react';
import type { ProofStatusView, VerificationView } from '../../../src/api-types';
import { api } from '../api';
import { useConfig } from '../app-context';
import { usePageData } from '../data';
import { describeError, formatBps, formatInt, formatUsdc, isAddress } from '../format';
import { AddressLink } from './AddressLink';
import { ActionButton } from './Confirm';
import { Details } from './Details';
import { ErrorBox, Spinner } from './Feedback';
import { Field, Input } from './Field';
import { Facts } from './Panel';
import { Pill } from './Pill';

const PROOF_KIND = 'antseed-wash-trading-seller-proof';

/** Registry contract facts and enforcement; the hashes live in a collapsed details block. */
export function VerificationRegistry({ data }: { data: VerificationView }) {
  const registry = data.registry;
  return (
    <div className="stack">
      {registry ? (
        <>
          <Facts
            items={[
              ['Registry', <AddressLink value={registry.address} />],
              ['Enforced', data.enforced ? <Pill tone="accent">enforced</Pill> : <Pill tone="muted">not enforced</Pill>],
              ['Flag threshold', `${formatBps(registry.thresholdBps)} of seller volume`],
              ['Period blocks', `${formatInt(registry.periodStartBlock)} – ${formatInt(registry.periodEndBlock)}`],
            ]}
          />
          <Details summary="Details">
            <Facts
              items={[
                ['Verifier', <AddressLink value={registry.verifier} short={false} />],
                ['Verifier hash', <span className="break mono small">{registry.verifierHash}</span>],
                ['Blockhash store', <AddressLink value={registry.blockhashStore} short={false} />],
                ['Seller program vkey', <span className="break mono small">{registry.sellerProgramVKey}</span>],
                ['Points policy', data.pointsPolicy ? <AddressLink value={data.pointsPolicy} short={false} /> : <span className="muted">not set</span>],
                ...data.policies.map<[string, ReactNode]>((policy) => [
                  'Policy → pinned registry',
                  <span>
                    <AddressLink value={policy.address} /> → {policy.washTradingRegistry ? <AddressLink value={policy.washTradingRegistry} /> : <span className="muted">not pinned</span>}
                  </span>,
                ]),
              ]}
            />
            <div className="hint mt">Enforced means the active points policy pins the registry, so flagged sellers earn no usage points.</div>
          </Details>
        </>
      ) : (
        <span className="muted">No wash-trading registry is deployed on this chain.</span>
      )}
    </div>
  );
}

/** Flagged / not flagged plus the proven share; the evidence digest is behind details. */
export function SellerStatus({ data, seller }: { data: VerificationView; seller: string }) {
  const s = data.seller;
  if (!s) {
    return (
      <div className="muted small">
        No verification record for <AddressLink value={seller} />.
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="row">
        {s.isProvenWashTrader ? <Pill tone="danger">flagged wash trader</Pill> : <Pill tone="accent">not flagged</Pill>}
        <span className="muted small">
          proven share <span className={`mono ${s.isProvenWashTrader ? 'danger' : ''}`}>{formatBps(s.provenWashShareBps)}</span>
        </span>
      </div>
      <Facts
        items={[
          ['Proven wash volume', `${formatUsdc(s.provenWashVolume)} USDC`],
          ['Total seller volume', `${formatUsdc(s.totalSellerVolume)} USDC`],
        ]}
      />
      <Details summary="Evidence">
        <Facts
          items={[
            ['Seller', <AddressLink value={s.seller} short={false} />],
            ['Evidence digest', <span className="break mono small">{s.evidenceDigest}</span>],
          ]}
        />
      </Details>
    </div>
  );
}

/** Wash-trading status of the dashboard wallet. */
export function OwnSellerStatus() {
  const { address } = useConfig();
  const page = usePageData('verification:own', () => api.verification(), 5 * 60_000);
  if (page.error && !page.data) return <ErrorBox error={page.error} onRetry={page.refresh} />;
  if (!page.data) {
    return (
      <span className="muted small">
        <Spinner /> loading…
      </span>
    );
  }
  if (!page.data.registry) return <span className="muted">No wash-trading registry is deployed on this chain.</span>;
  return <SellerStatus data={page.data} seller={address} />;
}

/** Address input that fetches another seller's verification record. */
export function SellerLookup() {
  const [input, setInput] = useState('');
  const [seller, setSeller] = useState<string | null>(null);
  const page = usePageData(seller ? `verification:${seller.toLowerCase()}` : null, () => api.verification(seller ?? undefined), 5 * 60_000);
  const valid = isAddress(input.trim());
  return (
    <div className="stack">
      <div className="form-row">
        <Input label="Seller address" width="lg" value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x…" />
        <Button variant="outline" onClick={() => setSeller(input.trim())} disabled={!valid}>
          Look up
        </Button>
      </div>
      {input.trim() && !valid ? <div className="error-text">Enter a 0x-prefixed 20-byte address.</div> : null}
      {seller && page.loading && !page.data ? (
        <span className="muted small">
          <Spinner /> loading…
        </span>
      ) : null}
      {seller && page.error && !page.data ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      {seller && page.data ? <SellerStatus data={page.data} seller={seller} /> : null}
    </div>
  );
}

interface ParsedProof {
  name: string;
  artifact: unknown;
  kind: string | null;
  seller: string | null;
}

function readKind(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const kind = (value as Record<string, unknown>)['kind'];
  return typeof kind === 'string' ? kind : null;
}

function readSeller(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const direct = record['seller'];
  if (typeof direct === 'string') return direct;
  const claim = record['claim'];
  if (typeof claim === 'object' && claim !== null) {
    const nested = (claim as Record<string, unknown>)['seller'];
    if (typeof nested === 'string') return nested;
  }
  return null;
}

export function ProofSubmit() {
  const [proof, setProof] = useState<ParsedProof | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setProof(null);
    setError(null);
    if (!file) return;
    try {
      const artifact: unknown = JSON.parse(await file.text());
      const kind = readKind(artifact);
      if (kind !== PROOF_KIND) {
        setError(`Expected a proof file with kind "${PROOF_KIND}"${kind ? `, got "${kind}"` : ''}.`);
        return;
      }
      setProof({ name: file.name, artifact, kind, seller: readSeller(artifact) });
    } catch (err) {
      setError(`Could not parse file as JSON: ${describeError(err)}`);
    }
  };

  return (
    <div className="stack">
      <div className="hint">
        Pick a seller proof produced by the loop-proof tooling (<code>{PROOF_KIND}</code>). Only the kind is checked here; the registry verifies the proof on chain. Submission may take several
        transactions (block references, chunks, finalize).
      </div>
      <div className="form-row">
        <Field label="Proof file">
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              void onFile(e);
            }}
          />
        </Field>
        <ActionButton
          label="Submit proof"
          variant="primary"
          title="Submit seller proof"
          path="/api/verification/submit"
          body={{ artifact: proof?.artifact }}
          disabled={!proof}
          disabledReason="Choose a valid proof file first."
        />
      </div>
      {error ? <div className="error-text">{error}</div> : null}
    </div>
  );
}

export function ProofLookup() {
  const [id, setId] = useState('');
  const [status, setStatus] = useState<ProofStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const lookup = async () => {
    const value = id.trim();
    if (!value) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      setStatus(await api.proofStatus(value));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stack">
      <div className="form-row">
        <Input label="Proof id" width="lg" value={id} onChange={(e) => setId(e.target.value)} placeholder="0x…" />
        <Button
          variant="outline"
          onClick={() => {
            void lookup();
          }}
          disabled={!id.trim() || loading}
        >
          {loading ? 'Looking up…' : 'Look up'}
        </Button>
      </div>
      {error ? <div className="error-text">{error}</div> : null}
      {status ? (
        <Facts
          items={[
            ['Proof id', <span className="break mono small">{status.proofId}</span>],
            ['Staged', status.staged ? 'yes' : 'no'],
            ['Finalized', status.finalized ? 'yes' : 'no'],
            ['Authenticated block references', formatInt(status.authenticatedBlockReferenceCount)],
            ['Authenticated block chunks', formatInt(status.authenticatedBlockChunkCount)],
          ]}
        />
      ) : null}
    </div>
  );
}
