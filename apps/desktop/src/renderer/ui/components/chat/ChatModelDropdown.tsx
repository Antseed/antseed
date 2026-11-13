import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, Route01Icon, Search01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { BrandIcon, modelFamilyLabel, resolveBrandKey } from '@antseed/ui';
import type { ChatModel } from '../../../types/bridge';
import { filterChatModels, findChatModel, formatPriceRange, isFreeOffer, selectionIsFree } from '../../../modules/chat/models';
import { splitPinnedModel } from '../../../../shared/pinned-model.js';
import { useDropdownDismiss } from '../../hooks/useDropdownDismiss';
import styles from './ChatModelDropdown.module.scss';

/** Width of the detail card beside the menu, and the gap between them. */
const CARD_WIDTH = 280;
const CARD_GAP = 8;

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

export type PickerTab = 'auto' | 'text' | 'image';

/** The tab a model is listed under: routers under Auto, then by type. */
export function pickerTabFor(model: ChatModel | null | undefined): PickerTab {
  if (model?.router) return 'auto';
  return model?.type === 'image' ? 'image' : 'text';
}

/** The lab whose mark a row shows, or null for a model no known lab makes. */
export function modelLab(model: ChatModel): string | null {
  if (model.router) return null;
  return modelFamilyLabel({ provider: model.id, label: model.label });
}

function ModelMark({ model, size }: { model: ChatModel; size: number }) {
  if (model.router) return <HugeiconsIcon icon={Route01Icon} size={size} strokeWidth={1.6} />;
  // Only labs' marks: an app or tool name inside a model id says nothing about who made it.
  return <BrandIcon brand={modelLab(model) ? resolveBrandKey(model.id, model.label) : 'generic'} size={size} />;
}

/** Tags for the detail card, most telling first. */
function modelTags(model: ChatModel): Array<{ label: string; tone?: 'free' | 'tee'; title?: string }> {
  return [
    model.router ? { label: 'Router', title: 'Picks the model for each message' } : null,
    model.free ? { label: 'Free', tone: 'free' as const } : null,
    model.tee ? (model.teeEndToEnd
      ? { label: 'TEE end to end', tone: 'tee' as const, title: 'Some of its sellers are sealed end to end: the seller and its model provider both run in a verified TEE' }
      : { label: 'TEE', tone: 'tee' as const, title: 'Some of its sellers run in a verified TEE; their model provider may not' }) : null,
    model.freeForStakers ? { label: 'Free for stakers', title: 'Some sellers serve it free to their stakers' } : null,
    model.type === 'text' && model.supportsImages ? { label: 'Vision' } : null,
    model.reasoning ? { label: 'Reasoning' } : null,
    model.toolUse ? { label: 'Tools' } : null,
  ].filter((tag): tag is NonNullable<typeof tag> => tag !== null);
}

type Hovered = { model: ChatModel; top: number; left: number };

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
  const headerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => findChatModel(models, selectedModelId), [models, selectedModelId]);
  const selectedListedId = splitPinnedModel(selectedModelId).modelId;
  const [freeOnly, setFreeOnly] = useState(false);
  const [tab, setTab] = useState<PickerTab>('text');
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const lists = useMemo(() => {
    const { routers, text, image } = filterChatModels(models, query, freeOnly ? 'free' : null);
    return { auto: routers, text, image };
  }, [models, query, freeOnly]);
  // Tabs for the kinds the gateway lists at all, so a filter can't hide a tab.
  const tabs = useMemo(() => {
    const kinds = new Set(models.map(pickerTabFor));
    return ([['auto', 'Auto'], ['text', 'Text'], ['image', 'Image']] as const).filter(([key]) => kinds.has(key));
  }, [models]);
  const hasFree = useMemo(() => models.some((model) => model.free), [models]);
  const shown = lists[tab];

  useDropdownDismiss(ref, open, setOpen);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setFreeOnly(false);
      setHovered(null);
      return;
    }
    // Open on the tab of the model in use.
    setTab(pickerTabFor(selected));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- only when it opens

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => {
      searchRef.current?.focus();
      // Open on the model in use, not at the top of a long list. Only the
      // menu scrolls: scrollIntoView would move the chat behind it too.
      const menu = menuRef.current;
      const item = menu?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
      if (menu && item) menu.scrollTop = centeredScrollTop(item.offsetTop, item.offsetHeight, menu.clientHeight, headerRef.current?.offsetHeight ?? 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, tab]);

  // Keep the detail card on screen once its height is known.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !hovered) return;
    const maxTop = window.innerHeight - card.offsetHeight - CARD_GAP;
    if (hovered.top > maxTop) card.style.top = `${Math.max(CARD_GAP, maxTop)}px`;
  }, [hovered]);

  /** Shows the detail card beside the menu, on whichever side has room; none without room. */
  function showDetails(model: ChatModel, row: HTMLElement) {
    const menu = menuRef.current;
    if (!menu) return;
    const menuRect = menu.getBoundingClientRect();
    const right = menuRect.right + CARD_GAP;
    const left = right + CARD_WIDTH <= window.innerWidth - CARD_GAP ? right : menuRect.left - CARD_GAP - CARD_WIDTH;
    setHovered(left >= CARD_GAP ? { model, top: row.getBoundingClientRect().top, left } : null);
  }

  const triggerLabel = selected?.label || selectedListedId || (loading ? 'Loading models…' : 'Select a model');

  function renderModel(model: ChatModel) {
    const active = model === selected;
    return (
      <button
        key={model.id}
        type="button"
        className={`${styles.pickerRow}${active ? ` ${styles.active}` : ''}`}
        role="option"
        aria-selected={active}
        onMouseEnter={(event) => showDetails(model, event.currentTarget)}
        onFocus={(event) => showDetails(model, event.currentTarget)}
        onClick={() => {
          setOpen(false);
          if (!active) onSelect(model.id);
        }}
      >
        <span className={styles.pickerMark}><ModelMark model={model} size={18} /></span>
        <span className={styles.pickerName}>{model.label}</span>
        <span className={styles.pickerTags}>
          {model.free && <span className={`${styles.tag} ${styles.tagFree}`}>Free</span>}
          {model.tee && <span className={`${styles.tag} ${styles.tagTee}`}>{model.teeEndToEnd ? 'TEE end to end' : 'TEE'}</span>}
          {active && <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} className={styles.itemCheck} aria-hidden />}
        </span>
      </button>
    );
  }

  function renderDetails({ model, top, left }: Hovered) {
    const lab = modelLab(model);
    const byline = model.router
      ? (model.router.sellerName && model.router.sellerName !== model.label ? `by ${model.router.sellerName}` : null)
      : lab;
    const price = renderModelPrice(model);
    const stats = [
      model.contextWindow ? { value: `${Math.round(model.contextWindow / 1000)}k`, label: 'context' } : null,
      model.router?.models ? { value: String(model.router.models), label: `model${model.router.models === 1 ? '' : 's'} it picks from` } : null,
      !model.router && model.sellers > 0 ? { value: String(model.sellers), label: `seller${model.sellers === 1 ? '' : 's'}` } : null,
    ].filter((stat): stat is NonNullable<typeof stat> => stat !== null);
    return (
      <div ref={cardRef} className={styles.pickerCard} style={{ top, left, width: CARD_WIDTH }} aria-hidden>
        <div className={styles.pickerCardHead}>
          <span className={styles.pickerCardMark}><ModelMark model={model} size={24} /></span>
          <span className={styles.pickerCardTitle}>
            <span className={styles.pickerCardName}>{model.label}</span>
            {byline && <span className={styles.pickerCardByline}>{byline}</span>}
          </span>
        </div>
        <div className={styles.itemTags}>
          {modelTags(model).map((tag) => (
            <span key={tag.label} title={tag.title} className={`${styles.tag}${tag.tone === 'free' ? ` ${styles.tagFree}` : tag.tone === 'tee' ? ` ${styles.tagTee}` : ''}`}>{tag.label}</span>
          ))}
        </div>
        {model.id !== model.label && <code className={styles.pickerCardId}>{model.id}</code>}
        {(stats.length > 0 || price) && (
          <div className={styles.pickerCardStats}>
            {stats.map((stat) => (
              <span key={stat.label} className={styles.pickerCardStat}><strong>{stat.value}</strong>{stat.label}</span>
            ))}
            {price && <span className={`${styles.pickerCardStat} ${styles.pickerCardPrice}`}><strong>{price}</strong>{model.router ? 'routing fee' : 'price'}</span>}
          </div>
        )}
      </div>
    );
  }

  const emptyText = loading ? 'Loading models…'
    : query || freeOnly ? 'No models match.'
      : models.length === 0 ? 'The gateway lists no models yet.' : 'No models here.';

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
        {selected && <span className={styles.pickerMark}><ModelMark model={selected} size={16} /></span>}
        <span className={styles.modelDropdownLabel}>{triggerLabel}</span>
        {selectionIsFree(selected, selectedModelId) && <span className={`${styles.tag} ${styles.tagFree}`}>Free</span>}
        <HugeiconsIcon icon={ArrowDown01Icon} size={16} strokeWidth={1.5} />
      </button>
      {open && (
        <div
          className={`${styles.modelDropdownMenu} ${styles.pickerMenu}${menuAnchor === 'container' ? ` ${styles.menuFullWidth}` : ` ${styles.modelMenu}`}${menuPlacement === 'above' ? ` ${styles.menuAbove}` : ''}`}
          role="listbox"
          ref={menuRef}
          onScroll={() => setHovered(null)}
          onMouseLeave={() => setHovered(null)}
          style={menuMaxHeight ? { maxHeight: menuMaxHeight } : undefined}
        >
          <div className={styles.pickerHeader} ref={headerRef}>
            <div className={styles.pickerSearchRow}>
              <label className={styles.pickerSearch}>
                <HugeiconsIcon icon={Search01Icon} size={15} strokeWidth={1.6} aria-hidden />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={holdEnterInSearch}
                  placeholder="Search models…"
                  aria-label="Search models"
                />
              </label>
              {hasFree && tab !== 'auto' && (
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
            {tabs.length > 1 && (
              <div className={styles.pickerTabs} role="tablist">
                {tabs.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    className={`${styles.pickerTab}${tab === key ? ` ${styles.pickerTabOn}` : ''}`}
                    title={key === 'auto' ? 'Routers pick the model for each message' : undefined}
                    onClick={() => { setTab(key); setHovered(null); }}
                  >
                    {label}
                    {/* While searching, where the matches are. */}
                    {query && <span className={styles.pickerTabCount}>{lists[key].length}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {error && (
            <div className={styles.modelDropdownStatus} role="alert">
              {error}
              {onRetry && (
                <button type="button" className={styles.modelDropdownRetry} onClick={onRetry}>Retry</button>
              )}
            </div>
          )}
          {!error && shown.length === 0 && <div className={styles.modelDropdownStatus}>{emptyText}</div>}
          {shown.map(renderModel)}
          {hovered && renderDetails(hovered)}
        </div>
      )}
    </div>
  );
}
