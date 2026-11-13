import { useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
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
  if (model.router) {
    const price = model.router.priceUsdPerRequest;
    // Only the pick is free; the model it picks may charge.
    if (price === 0) return <span className={styles.tag}>Free picks</span>;
    return price ? `$${price} per pick` : null;
  }
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

/** The menu scroll that centers an item below the sticky filters, never above the top. */
export function centeredScrollTop(itemTop: number, itemHeight: number, menuHeight: number, headerHeight = 0): number {
  return Math.max(0, itemTop - headerHeight - (menuHeight - headerHeight - itemHeight) / 2);
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
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => findChatModel(models, selectedModelId), [models, selectedModelId]);
  const selectedListedId = splitPinnedModel(selectedModelId).modelId;
  const [filter, setFilter] = useState<'free' | 'routers' | null>(null);
  const { routers, text, image } = useMemo(() => filterChatModels(models, query, filter), [models, query, filter]);
  const hasFree = useMemo(() => models.some((model) => model.free), [models]);
  const hasRouters = useMemo(() => models.some((model) => model.router), [models]);
  const toggleFilter = (next: 'free' | 'routers') => setFilter((value) => (value === next ? null : next));
  const showSearch = models.length >= SEARCH_THRESHOLD;

  useDropdownDismiss(ref, open, setOpen);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setFilter(null);
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      searchRef.current?.focus();
      // Open on the model in use, not at the top of a long list. Only the
      // menu scrolls: scrollIntoView would move the chat behind it too.
      const menu = menuRef.current;
      const item = menu?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
      const header = menu?.querySelector<HTMLElement>(`.${styles.modelDropdownFilters}`)?.offsetHeight ?? 0;
      if (menu && item) menu.scrollTop = centeredScrollTop(item.offsetTop, item.offsetHeight, menu.clientHeight, header);
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const triggerLabel = selected?.label || selectedListedId || (loading ? 'Loading models…' : 'Select a model');

  function renderModel(model: ChatModel) {
    const active = model === selected;
    const meta = model.router ? [
      model.router.sellerName && model.router.sellerName !== model.label ? `by ${model.router.sellerName}` : null,
      model.router.models ? `picks from ${model.router.models} model${model.router.models === 1 ? '' : 's'}` : null,
    ].filter(Boolean) : [
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
            {active && <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} className={styles.itemCheck} aria-hidden />}
          </span>
          <span className={styles.itemPrice}>{renderModelPrice(model)}</span>
        </span>
        <span className={styles.itemTags}>
          {model.router && <span className={styles.tag} title="Picks the model for each message">Router</span>}
          {model.type === 'image' && <span className={`${styles.tag} ${styles.tagBrand}`}>Image</span>}
          {model.tee && (model.teeEndToEnd
            ? <span className={`${styles.tag} ${styles.tagTee}`} title="Some of its sellers are sealed end to end: the seller and its model provider both run in a verified TEE">TEE end to end</span>
            : <span className={`${styles.tag} ${styles.tagTee}`} title="Some of its sellers run in a verified TEE; their model provider may not">TEE</span>)}
          {model.freeForStakers && <span className={styles.tag} title="Some sellers serve it free to their stakers">Free for stakers</span>}
          {model.type === 'text' && model.supportsImages && <span className={styles.tag}>Vision</span>}
          {model.reasoning && <span className={styles.tag}>Reasoning</span>}
          {model.toolUse && <span className={styles.tag}>Tools</span>}
          {model.sellers > 0 && !model.router && <span className={styles.itemSellers}>{model.sellers} seller{model.sellers === 1 ? '' : 's'}</span>}
        </span>
        {meta.length > 0 && <span className={styles.itemMeta}>{meta.map((part) => <span key={part}>{part}</span>)}</span>}
      </button>
    );
  }

  const empty = routers.length === 0 && text.length === 0 && image.length === 0;

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
          ref={menuRef}
          style={menuMaxHeight ? { maxHeight: menuMaxHeight } : undefined}
        >
          {(showSearch || hasFree || hasRouters) && (
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
              {hasRouters && (
                <button
                  type="button"
                  className={`${styles.freeFilter}${filter === 'routers' ? ` ${styles.freeFilterOn}` : ''}`}
                  aria-pressed={filter === 'routers'}
                  title="Routers pick the model for each message"
                  onClick={() => toggleFilter('routers')}
                >
                  Auto
                </button>
              )}
              {hasFree && (
                <button
                  type="button"
                  className={`${styles.freeFilter}${filter === 'free' ? ` ${styles.freeFilterOn}` : ''}`}
                  aria-pressed={filter === 'free'}
                  onClick={() => toggleFilter('free')}
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
              {loading ? 'Loading models…' : query || filter ? 'No models match.' : 'The gateway lists no models yet.'}
            </div>
          )}
          {routers.length > 0 && <div className={styles.modelDropdownSection}>Routers</div>}
          {routers.map(renderModel)}
          {text.length > 0 && (image.length > 0 || routers.length > 0) && <div className={styles.modelDropdownSection}>Text models</div>}
          {text.map(renderModel)}
          {image.length > 0 && <div className={styles.modelDropdownSection}>Image models</div>}
          {image.map(renderModel)}
        </div>
      )}
    </div>
  );
}
