import { useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import type { ChatModel } from '../../../types/bridge';
import { filterChatModels, findChatModel, formatPriceRange, isFreeOffer, selectionIsFree } from '../../../modules/chat/models';
import { splitPinnedModel } from '../../../../shared/pinned-model.js';
import { useDropdownDismiss } from '../../hooks/useDropdownDismiss';
import styles from './ChatModelDropdown.module.scss';

/** Show the search box once the list is long enough to need it. */
const SEARCH_THRESHOLD = 8;

type ChatModelDropdownProps = {
  models: ChatModel[];
  /** Model the composer sends with (text) — or the image model while image mode is on. */
  selectedModelId: string;
  loading: boolean;
  /** Readable reason the gateway's list failed; shown inside the menu. */
  error: string | null;
  disabled: boolean;
  onSelect: (modelId: string) => void;
  /** Called when the menu opens, so the list can refresh. */
  onOpen?: () => void;
  onOpenChange?: (open: boolean) => void;
  onRetry?: () => void;
  /** Caps the menu's height where there is less room below than in the chat header. */
  menuMaxHeight?: number;
  /**
   * `container`: the menu spans the nearest positioned ancestor (Home's
   * message box) instead of hanging off the trigger.
   */
  menuAnchor?: 'trigger' | 'container';
  /** `above`: the menu opens upward, for a picker below the message box. */
  menuPlacement?: 'below' | 'above';
};

/**
 * The chat composer's model picker: the gateway's `/v1/models`, one row per
 * model id. Text models drive the conversation; image models switch Send to
 * image generation.
 */
function renderModelPrice(model: ChatModel) {
  if (model.free) return <span className={`${styles.tag} ${styles.tagFree}`}>Free</span>;
  if (model.minImageUsd) return `from $${model.minImageUsd} per image`;
  // Not free to everyone, so a $0 price here is a stakers-only offer (the only sellers it has).
  if (isFreeOffer(model)) return model.stakersOnlyFreeSellerIds?.length ? <span className={styles.tag}>Free for stakers</span> : null;
  if (model.inputUsdPerMillion !== null || model.outputUsdPerMillion !== null) return `from ${formatPriceRange(model)}`;
  return null;
}

/** The search box sits inside Home's composer form, where Enter would send the draft. */
export function holdEnterInSearch(event: { key: string; preventDefault: () => void }): void {
  if (event.key === 'Enter') event.preventDefault();
}

export function ChatModelDropdown({
  models,
  selectedModelId,
  loading,
  error,
  disabled,
  onSelect,
  onOpen,
  onOpenChange,
  onRetry,
  menuMaxHeight,
  menuAnchor = 'trigger',
  menuPlacement = 'below',
}: ChatModelDropdownProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => findChatModel(models, selectedModelId), [models, selectedModelId]);
  const selectedListedId = splitPinnedModel(selectedModelId).modelId;
  const [freeOnly, setFreeOnly] = useState(false);
  const { text, image } = useMemo(() => filterChatModels(models, query, freeOnly), [models, query, freeOnly]);
  const hasFree = useMemo(() => models.some((model) => model.free), [models]);
  const showSearch = models.length >= SEARCH_THRESHOLD;

  useDropdownDismiss(ref, open, setOpen);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setFreeOnly(false);
      return undefined;
    }
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const triggerLabel = selected?.label || selectedListedId || (loading ? 'Loading models…' : 'Select a model');

  function renderModel(model: ChatModel) {
    const active = model === selected;
    const meta = [
      model.id !== model.label ? model.id : null,
      model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k context` : null,
    ].filter(Boolean);
    return (
      <button
        key={model.id}
        type="button"
        className={`${styles.modelDropdownItem}${active ? ` ${styles.active}` : ''}`}
        role="option"
        aria-selected={active}
        onClick={() => {
          setOpen(false);
          if (!active) onSelect(model.id);
        }}
      >
        <span className={styles.itemTopRow}>
          <span className={styles.itemNameGroup}>
            <span className={styles.itemName}>{model.label}</span>
          </span>
          <span className={styles.itemPrice}>{renderModelPrice(model)}</span>
        </span>
        <span className={styles.itemTags}>
          {model.type === 'image' && <span className={`${styles.tag} ${styles.tagBrand}`}>Image</span>}
          {model.tee && (model.teeEndToEnd
            ? <span className={`${styles.tag} ${styles.tagTee}`} title="Some of its sellers are sealed end to end: the seller and its model provider both run in a verified TEE">TEE end to end</span>
            : <span className={`${styles.tag} ${styles.tagTee}`} title="Some of its sellers run in a verified TEE; their model provider may not">TEE</span>)}
          {model.freeForStakers && <span className={styles.tag} title="Some sellers serve it free to their stakers">Free for stakers</span>}
          {model.type === 'text' && model.supportsImages && <span className={styles.tag}>Vision</span>}
          {model.reasoning && <span className={styles.tag}>Reasoning</span>}
          {model.toolUse && <span className={styles.tag}>Tools</span>}
          {model.sellers > 0 && <span className={styles.itemSellers}>{model.sellers} seller{model.sellers === 1 ? '' : 's'}</span>}
        </span>
        {meta.length > 0 && <span className={styles.itemMeta}>{meta.map((part) => <span key={part}>{part}</span>)}</span>}
      </button>
    );
  }

  const empty = text.length === 0 && image.length === 0;

  return (
    <div className={`${styles.modelDropdown}${menuAnchor === 'container' ? ` ${styles.anchorContainer}` : ''}`} ref={ref}>
      <button
        type="button"
        className={styles.modelDropdownTrigger}
        disabled={disabled}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((value) => !value);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected ? selected.id : undefined}
      >
        <span className={styles.modelDropdownLabel}>{triggerLabel}</span>
        {selectionIsFree(selected, selectedModelId) && <span className={`${styles.tag} ${styles.tagFree}`}>Free</span>}
        <HugeiconsIcon icon={ArrowDown01Icon} size={16} strokeWidth={1.5} />
      </button>
      {open && (
        <div
          className={`${styles.modelDropdownMenu}${menuAnchor === 'container' ? ` ${styles.menuFullWidth}` : ` ${styles.modelMenu}`}${menuPlacement === 'above' ? ` ${styles.menuAbove}` : ''}`}
          role="listbox"
          style={menuMaxHeight ? { maxHeight: menuMaxHeight } : undefined}
        >
          {(showSearch || hasFree) && (
            <div className={styles.modelDropdownFilters}>
              {showSearch && (
                <input
                  ref={searchRef}
                  className={styles.modelDropdownSearch}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={holdEnterInSearch}
                  placeholder="Search models…"
                  aria-label="Search models"
                />
              )}
              {hasFree && (
                <button
                  type="button"
                  className={`${styles.freeFilter}${freeOnly ? ` ${styles.freeFilterOn}` : ''}`}
                  aria-pressed={freeOnly}
                  onClick={() => setFreeOnly((value) => !value)}
                >
                  Free
                </button>
              )}
            </div>
          )}
          {error && (
            <div className={styles.modelDropdownStatus} role="alert">
              {error}
              {onRetry && (
                <button type="button" className={styles.modelDropdownRetry} onClick={onRetry}>Retry</button>
              )}
            </div>
          )}
          {!error && empty && (
            <div className={styles.modelDropdownStatus}>
              {loading ? 'Loading models…' : query || freeOnly ? 'No models match.' : 'The gateway lists no models yet.'}
            </div>
          )}
          {text.length > 0 && image.length > 0 && <div className={styles.modelDropdownSection}>Text models</div>}
          {text.map(renderModel)}
          {image.length > 0 && <div className={styles.modelDropdownSection}>Image models</div>}
          {image.map(renderModel)}
        </div>
      )}
    </div>
  );
}
