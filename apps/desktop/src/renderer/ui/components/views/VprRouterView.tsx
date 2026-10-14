import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { HierarchyIcon, InformationCircleIcon } from '@hugeicons/core-free-icons';
import { normalizeRouterAllowedModels, routingServiceKey, type RouterAllowedModel, type RoutingServiceEntry } from '../../../../shared/routing-selection';
import { useUiSelector, shallowEqual } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { projectRowsToVprModelCatalog } from '../../../modules/catalog/model-catalog';
import { loadVprRouterSettings } from '../../../modules/routing/preferences';
import { VprPage, VprSearch, VprStatRow, VprStatTile } from '../vpr/VprKit';
import { VprModelRowList } from '../vpr/VprModelRows';
import { routerPriceLabel } from '../vpr/VprRouterOptions';
import { InfoTooltip } from '../InfoTooltip';
import modelStyles from './VprModelView.module.scss';
import styles from './VprRouterView.module.scss';

const modelKey = (model: RouterAllowedModel) => JSON.stringify([model.provider, model.serviceId]);

const COST_QUALITY_STOPS = [
  { value: 0, label: 'Best quality', description: 'Strongest models, highest price.' },
  { value: 5, label: 'Balanced', description: 'Good answers at a moderate price.' },
  { value: 10, label: 'Lowest cost', description: 'Cheapest model that can handle the request.' },
] as const;
const DEFAULT_COST_QUALITY_STOP = 1;

function costQualityStopIndex(value: number | undefined): number {
  if (value === undefined) return DEFAULT_COST_QUALITY_STOP;
  let nearest = 0;
  COST_QUALITY_STOPS.forEach((stop, index) => {
    if (Math.abs(stop.value - value) < Math.abs(COST_QUALITY_STOPS[nearest].value - value)) nearest = index;
  });
  return nearest;
}

export function VprRouterView({ service }: { service: RoutingServiceEntry }) {
  const actions = useActions();
  const snapshot = useUiSelector((state) => ({ services: state.vprRoutingServices, selected: state.vprRouteSelection.router,
    rows: state.vprRoutableRows, rowsLoaded: state.chatDiscoverRowsLoaded, error: state.vprRouteError, discoveryError: state.vprRoutingServicesError }), shallowEqual);
  const key = routingServiceKey(service);
  const current = snapshot.services.find((entry) => routingServiceKey(entry) === key);
  const active = !!snapshot.selected && routingServiceKey(snapshot.selected.service) === key;
  const [initialSettings] = useState(() => active ? snapshot.selected : loadVprRouterSettings(service));
  const [costQualityTradeoff, setCostQualityTradeoff] = useState<number | undefined>(initialSettings?.costQualityTradeoff);
  const [savedAllowedModels, setAllowedModels] = useState<RouterAllowedModel[] | undefined>(initialSettings?.allowedModels);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const supported = current?.catalog;
  const catalogError = current?.catalogError ?? null;
  const catalog = useMemo(() => (supported?.models ?? []).flatMap(model => projectRowsToVprModelCatalog(
    snapshot.rows.filter(row => row.provider === model.provider && row.serviceId === model.serviceId),
  )).filter(entry => entry.kind === 'text'), [snapshot.rows, supported]);
  const availableModels = supported && !catalogError && snapshot.rowsLoaded ? catalog : undefined;
  const allowedModels = useMemo(() => normalizeRouterAllowedModels(savedAllowedModels, availableModels), [savedAllowedModels, availableModels]);
  useEffect(() => {
    if (allowedModels === savedAllowedModels) return;
    try {
      actions.updateVprRouterSettings(service, costQualityTradeoff, allowedModels);
      setAllowedModels(allowedModels);
      setSaveError(null);
    } catch (error) {
      setSaveError(`Could not save router settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [actions, service, costQualityTradeoff, allowedModels, savedAllowedModels]);
  const checkedKeys = useMemo(() => new Set((allowedModels ?? catalog).map(modelKey)), [allowedModels, catalog]);
  const visible = catalog.filter(entry => `${entry.label} ${entry.serviceId} ${entry.provider}`.toLowerCase().includes(search.trim().toLowerCase()));
  const noAvailableModels = !!supported && !catalog.some(model => checkedKeys.has(modelKey(model)));
  const label = current?.label ?? service.label;
  function updateSettings(nextCostQualityTradeoff: number | undefined, nextAllowedModels: RouterAllowedModel[] | undefined): void {
    nextAllowedModels = normalizeRouterAllowedModels(nextAllowedModels, availableModels);
    setCostQualityTradeoff(nextCostQualityTradeoff);
    setAllowedModels(nextAllowedModels);
    try {
      actions.updateVprRouterSettings(service, nextCostQualityTradeoff, nextAllowedModels);
      setSaveError(null);
    } catch (error) {
      setSaveError(`Could not save router settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const selectedStop = costQualityStopIndex(costQualityTradeoff);
  function selectStop(index: number): void {
    updateSettings(index === DEFAULT_COST_QUALITY_STOP ? undefined : COST_QUALITY_STOPS[index].value, allowedModels);
  }
  function toggleModel(provider: string, serviceId: string): void {
    const model = { provider, serviceId };
    const selected = allowedModels ?? catalog.map(({ provider, serviceId }) => ({ provider, serviceId }));
    updateSettings(costQualityTradeoff, selected.some(entry => modelKey(entry) === modelKey(model))
      ? selected.filter(entry => modelKey(entry) !== modelKey(model)) : [...selected, model]);
  }
  return <section className={`view view-vpr-model view-pinned-header ${styles.view}`} role="tabpanel">
    <VprPage title="Models" backFallback="explore">
      <div className={styles.stack}>
        <div className={modelStyles.headRow}>
          <div className={modelStyles.headText}>
            <div className={modelStyles.titleLine}>
              <HugeiconsIcon icon={HierarchyIcon} size={20} className={styles.logo} />
              <h1 className={styles.title}>{label}</h1>
            </div>
            <div className={modelStyles.badgeRow}><span className={modelStyles.modelTag}>Router</span></div>
          </div>
          <button type="button" className={modelStyles.use} aria-label={active ? 'Selected router' : 'Use router'}
            disabled={active || !current || !supported || !!catalogError || noAvailableModels}
            onClick={() => { if (current) actions.selectVprRouter(current, costQualityTradeoff, false, allowedModels); }}>
            {active ? 'Selected' : 'Use'}
          </button>
        </div>
        <div className={styles.pricing}>
          <VprStatRow>
            <VprStatTile label={current && Number(current.priceMicroUsdc) > 0 ? 'Price · /completed request' : 'Price'}
              value={<span className={styles.priceValue}>
                <span>{current ? routerPriceLabel(current.priceMicroUsdc) : 'Unavailable'}</span>
                <InfoTooltip content="Model inference is billed separately." align="left">
                  <button type="button" className={styles.priceInfo} aria-label="About router pricing">
                    <HugeiconsIcon icon={InformationCircleIcon} size={14} aria-hidden="true" />
                  </button>
                </InfoTooltip>
              </span>} tone="success" outlined />
          </VprStatRow>
        </div>
        <h2>Router settings</h2>
        <div className={styles.settings}>
          <div className={styles.settingText}>
            <h3 id="router-cost-quality-title" className={styles.settingTitle}>Cost / quality</h3>
            <p className={styles.hint}>How the router trades answer quality against price.</p>
          </div>
          <div id="router-cost-quality" className={styles.segmented} role="radiogroup" aria-labelledby="router-cost-quality-title"
            onKeyDown={event => {
              const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
              if (!step) return;
              event.preventDefault();
              const next = Math.min(COST_QUALITY_STOPS.length - 1, Math.max(0, selectedStop + step));
              selectStop(next);
              (event.currentTarget.children[next] as HTMLElement | undefined)?.focus();
            }}>
            {COST_QUALITY_STOPS.map((stop, index) => <button key={stop.value} type="button" role="radio"
              aria-checked={index === selectedStop} tabIndex={index === selectedStop ? 0 : -1}
              className={index === selectedStop ? styles.segmentSelected : styles.segment}
              onClick={() => selectStop(index)}>{stop.label}</button>)}
          </div>
          <p className={styles.segmentDescription}>
            <strong>{COST_QUALITY_STOPS[selectedStop].label}</strong>
            {' · '}{costQualityTradeoff === undefined ? "the router's default. " : ''}{COST_QUALITY_STOPS[selectedStop].description}
          </p>
        </div>
        <div className={styles.modelHeading}>
          <h2>Allowed models</h2>
          {supported && <label className={styles.allModels}><input type="checkbox" checked={allowedModels === undefined} disabled={!!catalogError || !catalog.length}
            onChange={event => updateSettings(costQualityTradeoff, event.currentTarget.checked ? undefined : catalog)} />All supported models</label>}
        </div>
        {!supported && !catalogError && <p role="status" className={styles.hint}>Router models are not available yet. Refresh discovery before routing.</p>}
        {catalogError && <p role="alert" className={styles.hint}>{catalogError}</p>}
        {supported && <>
        <p className={styles.hint}>Choose which supported models this router can use. If the router returns no allowed model, the request fails.</p>
        <VprSearch value={search} onChange={setSearch} placeholder="Search allowed models" />
        {noAvailableModels && <p role="status" className={styles.hint}>No supported models are currently available.</p>}
        <fieldset disabled={!!catalogError} className={styles.modelChoices}>
          <VprModelRowList entries={visible} checkedKeys={checkedKeys} selectOnly onSelect={toggleModel} emptyLabel="No matching supported models" />
        </fieldset>
        </>}
        {snapshot.discoveryError && <p role="alert" className={styles.hint}>{snapshot.discoveryError}</p>}
        {!current && <p role="status" className={styles.hint}>This router is unavailable. Wait for discovery or select another model or router.</p>}
        {saveError && <p role="alert" className={styles.hint}>{saveError}</p>}
        {active && snapshot.error && <p role="alert" className={styles.hint}>Could not apply router settings: {snapshot.error}</p>}
      </div>
    </VprPage>
  </section>;
}
