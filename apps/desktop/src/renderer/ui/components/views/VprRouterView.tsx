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
            <h3><label htmlFor="router-cost-quality">Cost / quality</label></h3>
            <p className={styles.hint}>0 = best quality · 10 = cheapest. Unset uses the router default (5).</p>
          </div>
          <input id="router-cost-quality" type="range" min={0} max={10} step={1}
            value={costQualityTradeoff ?? 5} aria-valuetext={costQualityTradeoff === undefined ? 'Router default (5)' : String(costQualityTradeoff)}
            onChange={event => updateSettings(Number(event.currentTarget.value), allowedModels)} />
          <output htmlFor="router-cost-quality">{costQualityTradeoff ?? 'Default (5)'}</output>
          <button type="button" disabled={costQualityTradeoff === undefined}
            onClick={() => updateSettings(undefined, allowedModels)}>Use router default</button>
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
