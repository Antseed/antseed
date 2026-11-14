import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, Route01Icon, Search01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { Badge, BrandIcon, modelFamilyLabel, resolveBrandKey } from '@antseed/ui';
import type { ChatModel } from '../../../types/bridge';
import { filterChatModels, findChatModel, formatPriceRange, formatUsdPerMillion, isFreeOffer, selectionIsFree } from '../../../modules/chat/models';
import { splitPinnedModel } from '../../../../shared/pinned-model.js';
import { useDropdownDismiss } from '../../hooks/useDropdownDismiss';
import styles from './ChatModelDropdown.module.scss';

/** Width of the detail card beside the menu, and the gap between them. */
/** The narrowest menu whose rows show their prices on one line; a narrower one gives each row a second line. */
const ONE_LINE_MIN_MENU_WIDTH = 520;

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
  /**
   * Video and decision models can't be picked: the chat model runs them through
   * its skills. Puts a prompt for one into the message box; without it those
   * rows only copy the prompt.
   */
  onUsePrompt?: (prompt: string) => void;
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
/** A model's price in words, and whether it reads as a tag (free) or plain text. */
export function modelPrice(model: ChatModel): { text: string; tag?: 'free' | 'plain' } | null {
  if (model.router) {
    const price = model.router.priceUsdPerRequest;
    // Only the pick is free; the model it picks may charge.
    if (price === 0) return { text: 'Free picks', tag: 'plain' };
    return price ? { text: `$${price} per pick` } : null;
  }
  if (model.free) return { text: 'Free', tag: 'free' };
  if (model.videoPrice) {
    const { perSecondUsd, perVideoUsd } = model.videoPrice;
    return { text: `from ${formatUsdPerUnit(perSecondUsd)} per second${perVideoUsd > 0 ? ` + ${formatUsdPerUnit(perVideoUsd)} per video` : ''}` };
  }
  if (model.minImageUsd) return { text: `from $${model.minImageUsd} per image` };
  // Not free to everyone, so a $0 price here is a stakers-only offer (the only sellers it has).
  if (isFreeOffer(model)) return model.stakersOnlyFreeSellerIds?.length ? { text: 'Free for stakers', tag: 'plain' } : null;
  if (model.inputUsdPerMillion !== null || model.outputUsdPerMillion !== null) return { text: `from ${formatPriceRange(model)}` };
  return null;
}

/**
 * The price chips a row shows beside its name: input and output per million
 * tokens side by side, or the cheapest price per image. None for free models
 * (their Free tag says it) or routers; each seller's price is in the seller
 * overview.
 */
/** A price per unit, short: "$0.17", "$0.103", "$0.005", "$1.25". */
export function formatUsdPerUnit(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  // A positive price never reads as $0: below a tenth of a cent, two significant digits.
  if (value > 0 && value < 0.001) return `$${Number(value.toPrecision(2))}`;
  const text = value.toFixed(3).replace(/0+$/, '');
  return (text.split('.')[1] ?? '').length < 2 ? `$${value.toFixed(2)}` : `$${text}`;
}

export function rowPriceChips(model: ChatModel): Array<{ label: string; price: string }> {
  if (model.router) {
    const fee = model.router.priceUsdPerRequest;
    // Only the pick is priced here; the model it picks may charge too.
    return fee === null ? [] : [{ label: '', price: fee === 0 ? 'Free picks' : `${formatUsdPerUnit(fee)}/pick` }];
  }
  if (model.free) return [];
  if (model.videoPrice) {
    const { perSecondUsd, perVideoUsd } = model.videoPrice;
    return [
      { label: 'from', price: `${formatUsdPerUnit(perSecondUsd)}/s` },
      ...(perVideoUsd > 0 ? [{ label: '+', price: `${formatUsdPerUnit(perVideoUsd)}/video` }] : []),
    ];
  }
  // Before the token check: image sellers list $0 token prices beside their price per image.
  if (model.minImageUsd) return [{ label: 'from', price: `$${model.minImageUsd}/image` }];
  if (isFreeOffer(model)) return [];
  if (model.inputUsdPerMillion === null && model.outputUsdPerMillion === null) return [];
  return [
    { label: 'in', price: `${formatUsdPerMillion(model.inputUsdPerMillion)}/M` },
    { label: 'out', price: `${formatUsdPerMillion(model.outputUsdPerMillion)}/M` },
  ];
}

/** A row's name with its price chips, or, in a narrow menu, with a second line of details. */
function ModelRowContent({ model, oneLine, tags }: { model: ChatModel; oneLine: boolean; tags?: ReactNode }) {
  if (!oneLine) {
    return (
      <span className={styles.pickerNameGroup}>
        <span className={styles.pickerName}>{model.label}</span>
        <span className={styles.pickerInlineDetails}>{modelInlineDetails(model)}</span>
      </span>
    );
  }
  // Tags right after the name, so the price chips end every row in the same place.
  return (
    <>
      <span className={styles.pickerNameLine}>
        <span className={styles.pickerName}>{model.label}</span>
        {tags}
      </span>
      {renderRowPriceChips(model)}
    </>
  );
}

function renderRowPriceChips(model: ChatModel) {
  const chips = rowPriceChips(model);
  if (chips.length === 0) return null;
  return (
    <span className={styles.pickerPrices}>
      {chips.map((chip) => (
        <Badge key={chip.label || chip.price} variant="soft">
          {chip.label && <span className={styles.pickerPriceLabel}>{chip.label}</span>}
          {chip.price}
        </Badge>
      ))}
    </span>
  );
}

/** The search box sits inside Home's composer form, where Enter would send the draft. */
export function holdEnterInSearch(event: { key: string; preventDefault: () => void }): void {
  if (event.key === 'Enter') event.preventDefault();
}

/** The menu scroll that centers an item below the sticky filters, never above the top. */
export function centeredScrollTop(itemTop: number, itemHeight: number, menuHeight: number, headerHeight = 0): number {
  return Math.max(0, itemTop - headerHeight - (menuHeight - headerHeight - itemHeight) / 2);
}

export type PickerTab = 'auto' | 'text' | 'image' | 'video' | 'decision';

/** Tabs whose models the chat model runs through a skill: listed, never picked. */
export const PROMPT_TABS: ReadonlySet<PickerTab> = new Set(['video', 'decision']);

/** The tab a model is listed under: routers under Auto, then by type. */
export function pickerTabFor(model: ChatModel | null | undefined): PickerTab {
  if (model?.router) return 'auto';
  if (model?.type === 'image' || model?.type === 'video' || model?.type === 'decision') return model.type;
  return 'text';
}

/** The message that has the chat model run a video or decision model through its skill. */
export function skillPrompt(model: ChatModel): string {
  return model.type === 'video'
    ? `Make a video with the model ${model.id} (antseed-videos skill) of: `
    : `Use the decision model ${model.id} (antseed-decisions skill) to answer: `;
}

/** The tab the picker opens on: the model in use's, or the first tab that lists anything. */
export function initialPickerTab(selected: ChatModel | null | undefined, tabs: readonly PickerTab[]): PickerTab {
  const own = pickerTabFor(selected);
  return tabs.includes(own) || tabs.length === 0 ? own : tabs[0]!;
}

/** Each tab's rows. Free narrows Text and Image only: a router's pick is priced alone, and Auto has no Free toggle. */
export function pickerLists(models: ChatModel[], query: string, freeOnly: boolean): Record<PickerTab, ChatModel[]> {
  const { routers, text, image } = filterChatModels(models, query, null);
  const needle = query.trim().toLowerCase();
  const ofType = (type: string) => models
    .filter((model) => model.type === type && !model.router
      && (!needle || model.id.toLowerCase().includes(needle) || model.label.toLowerCase().includes(needle)))
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }));
  return {
    auto: routers,
    text: freeOnly ? text.filter((model) => model.free) : text,
    image: freeOnly ? image.filter((model) => model.free) : image,
    video: ofType('video'),
    decision: ofType('decision'),
  };
}

/** Whether a menu `menuWidth` wide shows each row on one line, with its price chips. */
export function oneLineFits(menuWidth: number): boolean {
  return menuWidth >= ONE_LINE_MIN_MENU_WIDTH;
}

/** A context window as the picker writes it ("256k"), or null. */
function contextValue(model: ChatModel): string | null {
  return model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : null;
}

/** How many models a router picks from ("4 models"), or null. */
function routerModelCount(model: ChatModel): string | null {
  const count = model.router?.models;
  return count ? `${count} model${count === 1 ? '' : 's'}` : null;
}

/** What a row's detail card shows, for screen readers, which skip the card. */
export function modelSummary(model: ChatModel): string {
  const lab = modelLab(model);
  const context = contextValue(model);
  const picks = routerModelCount(model);
  return [
    model.router?.sellerName ? `by ${model.router.sellerName}` : lab,
    modelTags(model).map((tag) => tag.label).join(', ') || null,
    modelPrice(model)?.text,
    context ? `${context} context` : null,
    picks ? `picks from ${picks}` : null,
    !model.router && model.sellers > 0 ? `${model.sellers} seller${model.sellers === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join('. ');
}

/** The short line a row shows when the card has no room: what the row's tags don't already say. */
export function modelInlineDetails(model: ChatModel): string {
  const price = modelPrice(model);
  const context = contextValue(model);
  const picks = routerModelCount(model);
  // Free and the TEE tag are on the row already.
  const onRow = new Set(['Router', 'Free', 'Free for stakers', teeTag(model)?.label]);
  const tags = modelTags(model).filter((tag) => !onRow.has(tag.label)).map((tag) => tag.label);
  return [
    model.router?.sellerName ? `by ${model.router.sellerName}` : modelLab(model),
    price && price.tag !== 'free' ? price.text : null,
    context ? `${context} context` : null,
    picks ? `picks from ${picks}` : null,
    ...tags,
  ].filter(Boolean).join(' · ');
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

// As the gateway console words it (TeeBadge): Full when the attestation reaches
// the model provider, Partial when only the seller node is attested.
const FULL_TEE = 'Full TEE: the seller node and its model provider both run in verified TEEs.';
const PARTIAL_TEE = 'Partial TEE: only the seller node runs in a verified TEE. Its model provider is not TEE-attested and may see requests.';

/** The model's TEE tag: Full TEE when some seller is sealed end to end, Partial TEE when only seller nodes are. */
function teeTag(model: ChatModel): { label: string; tone?: 'tee'; title: string } | null {
  if (!model.tee) return null;
  return model.teeEndToEnd
    ? { label: 'Full TEE', tone: 'tee', title: FULL_TEE }
    : { label: 'Partial TEE', title: PARTIAL_TEE };
}

/** Tags for the detail card, most telling first. */
function modelTags(model: ChatModel): Array<{ label: string; tone?: 'free' | 'tee'; title?: string }> {
  return [
    model.router ? { label: 'Router', title: 'Picks the model for each message' } : null,
    model.free ? { label: 'Free', tone: 'free' as const } : null,
    teeTag(model),
    model.freeForStakers ? { label: 'Free for stakers', title: 'Some sellers serve it free to their stakers' } : null,
    model.type === 'text' && model.supportsImages ? { label: 'Vision' } : null,
    model.reasoning ? { label: 'Reasoning' } : null,
    model.toolUse ? { label: 'Tools' } : null,
  ].filter((tag): tag is NonNullable<typeof tag> => tag !== null);
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
  onUsePrompt,
}: ChatModelDropdownProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => findChatModel(models, selectedModelId), [models, selectedModelId]);
  const selectedListedId = splitPinnedModel(selectedModelId).modelId;
  const [freeOnly, setFreeOnly] = useState(false);
  const [tab, setTab] = useState<PickerTab>('text');
  // A narrow menu: each row gets a second line with its details instead of chips.
  const [oneLine, setOneLine] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  useEffect(() => {
    if (!copiedId) return undefined;
    const timer = setTimeout(() => setCopiedId(null), 1500);
    return () => clearTimeout(timer);
  }, [copiedId]);
  const lists = useMemo(() => pickerLists(models, query, freeOnly), [models, query, freeOnly]);
  // Tabs for the kinds the gateway lists at all, so a filter can't hide a tab.
  const tabs = useMemo(() => {
    const kinds = new Set(models.map(pickerTabFor));
    return ([['auto', 'Auto'], ['text', 'Text'], ['image', 'Image'], ['video', 'Video'], ['decision', 'Decision']] as const)
      .filter(([key]) => kinds.has(key));
  }, [models]);
  const hasFree = useMemo(() => models.some((model) => model.free), [models]);
  const shown = lists[tab];

  useDropdownDismiss(ref, open, setOpen);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setFreeOnly(false);
      return;
    }
    // Open on the tab of the model in use.
    setTab(initialPickerTab(selected, tabs.map(([key]) => key)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- only when it opens

  // The list can change while the menu is open: never stay on a tab that's gone.
  useEffect(() => {
    const keys = tabs.map(([key]) => key);
    if (open && keys.length > 0 && !keys.includes(tab)) setTab(initialPickerTab(selected, keys));
  }, [open, tabs, tab, selected]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const menu = menuRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      setOneLine(oneLineFits(rect.width));
    };
    measure();
    // A resized window can widen or narrow the menu.
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

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

  const triggerLabel = selected?.label || selectedListedId || (loading ? 'Loading models…' : 'Select a model');

  function renderModel(model: ChatModel) {
    const active = model === selected;
    const tee = teeTag(model);
    const tags = (
      <>
        {model.free && <span className={`${styles.tag} ${styles.tagFree}`}>Free</span>}
        {tee && <span title={tee.title} className={`${styles.tag}${tee.tone ? ` ${styles.tagTee}` : ''}`}>{tee.label}</span>}
        {model.freeForStakers && !model.free && <span className={styles.tag} title="Some sellers serve it free to their stakers">Free for stakers</span>}
      </>
    );
    return (
      <button
        key={model.id}
        type="button"
        className={`${styles.pickerRow}${oneLine ? '' : ` ${styles.pickerRowTall}`}${active ? ` ${styles.active}` : ''}`}
        role="option"
        aria-selected={active}
        aria-label={`${model.label}. ${modelSummary(model)}`}
        // The details a card used to show (lab, context, capabilities, sellers), without one.
        title={modelSummary(model)}
        onClick={() => {
          setOpen(false);
          if (!active) onSelect(model.id);
        }}
      >
        <span className={styles.pickerMark}><ModelMark model={model} size={18} /></span>
        <ModelRowContent model={model} oneLine={oneLine} tags={oneLine ? tags : undefined} />
        <span className={styles.pickerTags}>
          {!oneLine && tags}
          {/* The tick's place is kept on every row, so the selected row's chips don't move. */}
          <span className={styles.pickerCheck}>
            {active && <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} className={styles.itemCheck} aria-hidden />}
          </span>
        </span>
      </button>
    );
  }

  /** A video or decision row: not pickable; it starts or copies a prompt for the chat model. */
  function renderPromptModel(model: ChatModel) {
    const prompt = skillPrompt(model);
    return (
      <div
        key={model.id}
        className={`${styles.pickerRow} ${styles.pickerPromptRow}${oneLine ? '' : ` ${styles.pickerRowTall}`}`}
      >
        <span className={styles.pickerMark}><ModelMark model={model} size={18} /></span>
        <ModelRowContent model={model} oneLine={oneLine} />
        <span className={styles.pickerTags}>
          {onUsePrompt && (
            <button
              type="button"
              className={styles.pickerAction}
              aria-label={`Use ${model.label} in the chat`}
              onClick={() => {
                setOpen(false);
                onUsePrompt(prompt);
              }}
            >
              Use in chat
            </button>
          )}
          <button
            type="button"
            className={styles.pickerAction}
            aria-label={`Copy a prompt for ${model.label}`}
            onClick={() => {
              void navigator.clipboard?.writeText(prompt).then(() => setCopiedId(model.id)).catch(() => {});
            }}
          >
            {copiedId === model.id ? 'Copied' : 'Copy prompt'}
          </button>
        </span>
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
              {hasFree && (tab === 'text' || tab === 'image') && (
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
                    onClick={() => setTab(key)}
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
          {!error && PROMPT_TABS.has(tab) && shown.length > 0 && (
            <div className={styles.modelDropdownStatus}>
              {tab === 'video' ? 'Video models' : 'Decision models'} run through your chat model: start a prompt for one, or copy it.
            </div>
          )}
          {!error && shown.length === 0 && <div className={styles.modelDropdownStatus}>{emptyText}</div>}
          {shown.map(PROMPT_TABS.has(tab) ? renderPromptModel : renderModel)}
        </div>
      )}
    </div>
  );
}
