import { useCallback, useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, ShuffleIcon } from '@hugeicons/core-free-icons';
import type { ChatRouteCandidate, ChatRoutePreview } from '../../../types/bridge';
import { formatPriceRange, isFreeOffer } from '../../../modules/chat/models';
import { splitPinnedModel } from '../../../../shared/pinned-model.js';
import { usePrivateMode } from '../vpr/PrivacyToggle';
import { useDropdownDismiss } from '../../hooks/useDropdownDismiss';
import { usePrivacySwitch } from '../../../modules/app/vpr-resources';
import { selectHasFunds } from '../../../core/balance';
import { useUiSelector } from '../../hooks/useUiSelector';
import styles from './ChatModelDropdown.module.scss';

type ChatSellerPickerProps = {
  onOpenChange?: (open: boolean) => void;
  /** The chat's model, `peer@model` when a seller is pinned. */
  modelId: string;
  disabled: boolean;
  /** Pins a seller, or null for Auto. */
  onChange: (peerId: string | null) => void;
  menuMaxHeight?: number;
  /** Narrow spots: the trigger says "Auto" without naming Auto's current pick. */
  compact?: boolean;
  /**
   * `container`: the menu spans the nearest positioned ancestor (Home's
   * message box) instead of hanging off the trigger.
   */
  menuAnchor?: 'trigger' | 'container';
};

function shortId(peerId: string): string {
  return `${peerId.slice(0, 6)}…${peerId.slice(-4)}`;
}

function sellerName(candidate: { peerId: string; name: string | null }): string {
  return candidate.name ?? shortId(candidate.peerId);
}

/** A stable colour per seller, so the same seller always looks the same. Hues 30–329: red reads as an error. */
function sellerColor(peerId: string): string {
  let hash = 0;
  for (const char of peerId) hash = (hash * 31 + char.charCodeAt(0)) % 300;
  return `hsl(${hash + 30} 55% 50%)`;
}

function stats(candidate: ChatRouteCandidate): string {
  return [
    candidate.successRate !== null ? `${Math.round(candidate.successRate * 100)}% success` : null,
    candidate.firstTokenMs !== null ? `${(candidate.firstTokenMs / 1000).toFixed(1)}s first token` : null,
    candidate.tokensPerSecond !== null ? `${Math.round(candidate.tokensPerSecond)} tok/s` : null,
  ].filter(Boolean).join(' · ');
}

const SORT_LABELS: Record<string, string> = {
  'expected-cost': 'lowest expected cost of a good answer',
  price: 'cheapest seller',
  balanced: 'best mix of price, trust and speed',
  trust: 'most trusted seller',
  speed: 'fastest seller',
  latency: 'fastest first token',
};

/**
 * Which seller serves the chat's model: Auto (the gateway's routing policy
 * picks, as for any app using the key) or one seller pinned. Only sellers the
 * key's policy allows can be pinned — the route preview says which, and the
 * gateway refuses any other pin.
 */
export function ChatSellerPicker({ modelId, disabled, onChange, onOpenChange, menuMaxHeight, compact = false, menuAnchor = 'trigger' }: ChatSellerPickerProps) {
  const { modelId: listedId, peerId: pinnedPeerId } = splitPinnedModel(modelId);
  const [open, setOpen] = useState(false);
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  const [preview, setPreview] = useState<ChatRoutePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  // Anonymous / Private changes the key's routing policy, so which sellers pass it.
  const privateMode = usePrivateMode();
  const freeSellerId = useUiSelector((state) => (selectHasFunds(state)
    ? null
    : state.chatModels.find((model) => model.id === listedId)?.freeSellerId ?? null));

  const load = useCallback((force = false) => {
    if (!listedId) return;
    const request = ++requestRef.current;
    setLoading(true);
    void (window.antseedDesktop?.chatRoutePreview?.(listedId, { force }) ?? Promise.resolve({ ok: false, error: 'Unavailable' }))
      .then((result) => {
        if (request !== requestRef.current) return;
        if (result.ok && result.data) {
          setPreview(result.data);
          setError(null);
        } else {
          setError(result.error ?? 'Could not load the sellers for this model.');
        }
      })
      .catch((err: unknown) => {
        if (request === requestRef.current) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (request === requestRef.current) setLoading(false);
      });
  }, [listedId]);

  // A preview read mid-switch shows the old policy's sellers.
  const { switching: privacySwitching } = usePrivacySwitch();
  const wasSwitching = useRef(privacySwitching);
  useEffect(() => {
    if (wasSwitching.current && !privacySwitching) load(true);
    wasSwitching.current = privacySwitching;
  }, [load, privacySwitching]);

  // The trigger names Auto's current pick, so the preview loads with the model.
  const firstPrivacy = useRef(privateMode);
  useEffect(() => {
    setPreview(null);
    setError(null);
    const changed = firstPrivacy.current !== privateMode;
    firstPrivacy.current = privateMode;
    load(changed);
  }, [load, privateMode]);

  useDropdownDismiss(ref, open, setOpen);

  if (!listedId) return null;

  const candidates = preview?.candidates ?? [];
  const eligible = candidates.filter((candidate) => candidate.eligible);
  const excluded = candidates.filter((candidate) => !candidate.eligible);
  // Without funds the buyer falls through to the free sellers, so show one as Auto.
  const autoPick = eligible.find((candidate) => candidate.peerId === freeSellerId) ?? eligible[0] ?? null;
  const pinned = pinnedPeerId ? candidates.find((candidate) => candidate.peerId === pinnedPeerId) ?? null : null;
  const pinnedExcluded = pinned !== null && !pinned.eligible;
  const sortLabel = preview?.sort ? SORT_LABELS[preview.sort] ?? preview.sort : null;

  const triggerText = pinnedPeerId
    ? pinned ? sellerName(pinned) : shortId(pinnedPeerId)
    : autoPick && !compact ? `Auto · ${sellerName(autoPick)}` : 'Auto';

  function pick(peerId: string | null): void {
    setOpen(false);
    if (peerId !== pinnedPeerId) onChange(peerId);
  }

  return (
    <div className={`${styles.modelDropdown}${menuAnchor === 'container' ? ` ${styles.anchorContainer}` : ''}`} ref={ref}>
      <button
        type="button"
        className={`${styles.modelDropdownTrigger} ${styles.sellerTrigger}`}
        disabled={disabled}
        onClick={() => {
          if (!open) load();
          setOpen((value) => !value);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={pinnedPeerId
          ? 'Pinned: every turn goes to this seller'
          : `Auto: your gateway's routing policy picks the seller${autoPick ? ` (now ${sellerName(autoPick)})` : ''}`}
      >
        {pinnedPeerId
          ? <span className={styles.sellerDot} style={{ background: sellerColor(pinnedPeerId) }} aria-hidden="true" />
          : <HugeiconsIcon icon={ShuffleIcon} size={14} strokeWidth={1.8} />}
        <span className={`${styles.modelDropdownLabel} ${styles.sellerLabel}`}>{triggerText}</span>
        {pinnedExcluded && <span className={styles.sellerWarnDot} aria-label="Not allowed by your routing policy" />}
        <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.5} />
      </button>
      {open && (
        <div
          className={`${styles.modelDropdownMenu} ${styles.sellerMenu}${menuAnchor === 'container' ? ` ${styles.menuFullWidth}` : ''}`}
          role="listbox"
          style={menuMaxHeight ? { maxHeight: menuMaxHeight } : undefined}
        >
          {error && (
            <div className={styles.modelDropdownStatus} role="alert">
              {error}
              <button type="button" className={styles.modelDropdownRetry} onClick={() => load(true)}>Retry</button>
            </div>
          )}
          {!error && !preview && loading && <div className={styles.modelDropdownStatus}>Loading sellers…</div>}
          {preview && !preview.modelAllowed && (
            <div className={styles.modelDropdownStatus}>Your gateway&apos;s routing policy does not allow this model.</div>
          )}

          {preview?.modelAllowed !== false && (
            <button
              type="button"
              className={`${styles.modelDropdownItem}${!pinnedPeerId ? ` ${styles.active}` : ''}`}
              role="option"
              aria-selected={!pinnedPeerId}
              onClick={() => pick(null)}
            >
              <span className={styles.itemTopRow}>
                <span className={styles.itemNameGroup}>
                  <HugeiconsIcon icon={ShuffleIcon} size={14} strokeWidth={1.8} />
                  <span className={styles.itemName}>Auto</span>
                  <span className={styles.tag}>Recommended</span>
                </span>
                {autoPick && (
                  <span className={styles.itemPrice}>
                    {isFreeOffer(autoPick) ? <span className={`${styles.tag} ${styles.tagFree}`}>Free</span> : formatPriceRange(autoPick)}
                  </span>
                )}
              </span>
              <span className={styles.itemMeta}>
                {autoPick
                  ? `Your gateway's routing policy picks${sortLabel ? ` the ${sortLabel}` : ''} — now ${sellerName(autoPick)}`
                  : preview ? 'No seller passes your routing policy for this model right now.' : 'Your gateway\'s routing policy picks the seller.'}
              </span>
            </button>
          )}

          {eligible.length > 0 && <div className={styles.modelDropdownSection}>Pin a seller · {eligible.length} allowed</div>}
          {eligible.map((candidate) => {
            const active = candidate.peerId === pinnedPeerId;
            return (
              <button
                key={candidate.peerId}
                type="button"
                className={`${styles.modelDropdownItem}${active ? ` ${styles.active}` : ''}`}
                role="option"
                aria-selected={active}
                onClick={() => pick(candidate.peerId)}
                title={candidate.reasons.join(', ')}
              >
                <span className={styles.itemTopRow}>
                  <span className={styles.itemNameGroup}>
                    <span className={styles.sellerDot} style={{ background: sellerColor(candidate.peerId) }} aria-hidden="true" />
                    <span className={styles.itemName}>{sellerName(candidate)}</span>
                    {candidate.failing && <span className={styles.tag}>Failing</span>}
                  </span>
                  <span className={styles.itemPrice}>
                    {isFreeOffer(candidate) ? <span className={`${styles.tag} ${styles.tagFree}`}>Free</span> : formatPriceRange(candidate)}
                  </span>
                </span>
                <span className={styles.itemMeta}>
                  {stats(candidate) || 'No traffic history yet'}
                  {candidate.trustScore !== null && <span>trust {Math.round(candidate.trustScore)}</span>}
                </span>
              </button>
            );
          })}

          {excluded.length > 0 && <div className={styles.modelDropdownSection}>Not allowed by your routing policy · {excluded.length}</div>}
          {excluded.map((candidate) => (
            <div key={candidate.peerId} className={`${styles.modelDropdownItem} ${styles.itemDisabled}`} aria-disabled="true">
              <span className={styles.itemTopRow}>
                <span className={styles.itemNameGroup}>
                  <span className={styles.sellerDot} style={{ background: sellerColor(candidate.peerId) }} aria-hidden="true" />
                  <span className={styles.itemName}>{sellerName(candidate)}</span>
                </span>
                <span className={styles.itemPrice}>{formatPriceRange(candidate)}</span>
              </span>
              <span className={styles.itemMeta}>{candidate.reasons[0] ?? 'Excluded by your routing policy'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
