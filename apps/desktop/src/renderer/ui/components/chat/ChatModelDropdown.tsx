import { useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import type { ChatModel } from '../../../types/bridge';
import { filterChatModels, findChatModel, formatPriceRange } from '../../../modules/chat/models';
import { splitPinnedModel } from '../../../../shared/pinned-model.js';
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
  onRetry?: () => void;
  /** Caps the menu's height where there is less room below than in the chat header. */
  menuMaxHeight?: number;
  /**
   * `container`: the menu spans the nearest positioned ancestor (Home's
   * message box) instead of hanging off the trigger.
   */
  menuAnchor?: 'trigger' | 'container';
};

/**
 * The chat composer's model picker: the gateway's `/v1/models`, one row per
 * model id. Text models drive the conversation; image models switch Send to
 * image generation.
 */
export function ChatModelDropdown({
  models,
  selectedModelId,
  loading,
  error,
  disabled,
  onSelect,
  onOpen,
  onRetry,
  menuMaxHeight,
  menuAnchor = 'trigger',
}: ChatModelDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => findChatModel(models, selectedModelId), [models, selectedModelId]);
  const selectedListedId = splitPinnedModel(selectedModelId).modelId;
  const { text, image } = useMemo(() => filterChatModels(models, query), [models, query]);
  const showSearch = models.length >= SEARCH_THRESHOLD;

  useEffect(() => {
    if (!open) {
      setQuery('');
      return undefined;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      cancelAnimationFrame(frame);
    };
  }, [open]);

  const triggerLabel = selected?.label || selectedListedId || (loading ? 'Loading models…' : 'Select a model');

  function renderModel(model: ChatModel) {
    const active = model.id === selectedListedId;
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
          <span className={styles.itemPrice}>
            {model.free
              ? <span className={`${styles.tag} ${styles.tagFree}`}>Free</span>
              : model.inputUsdPerMillion !== null || model.outputUsdPerMillion !== null
                ? `from ${formatPriceRange(model)}`
                : null}
          </span>
        </span>
        <span className={styles.itemTags}>
          {model.type === 'image' && <span className={`${styles.tag} ${styles.tagBrand}`}>Image</span>}
          {model.tee && <span className={`${styles.tag} ${styles.tagTee}`} title="Some sellers run it in a verified TEE">TEE</span>}
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
        {selected?.free && <span className={`${styles.tag} ${styles.tagFree}`}>Free</span>}
        <HugeiconsIcon icon={ArrowDown01Icon} size={16} strokeWidth={1.5} />
      </button>
      {open && (
        <div
          className={`${styles.modelDropdownMenu}${menuAnchor === 'container' ? ` ${styles.menuFullWidth}` : ''}`}
          role="listbox"
          style={menuMaxHeight ? { maxHeight: menuMaxHeight } : undefined}
        >
          {showSearch && (
            <input
              ref={searchRef}
              className={styles.modelDropdownSearch}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models…"
              aria-label="Search models"
            />
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
              {loading ? 'Loading models…' : query ? 'No models match.' : 'The gateway lists no models yet.'}
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
