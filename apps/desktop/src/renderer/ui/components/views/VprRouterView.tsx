import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { HierarchyIcon, InformationCircleIcon } from '@hugeicons/core-free-icons';
import { normalizeRouterAllowedModels, routerDisplayName, routerSellerName, routingServiceKey, type RouterAllowedModel, type RouterOptions, type RouterOptionSpec, type RoutingServiceEntry } from '../../../../shared/routing-selection';
import { useUiSelector, shallowEqual } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { projectRowsToVprModelCatalog } from '../../../modules/catalog/model-catalog';
import { loadVprRouterSettings } from '../../../modules/routing/preferences';
import { VprPage, VprSearch, VprSlider, VprStatRow, VprStatTile } from '../vpr/VprKit';
import { VprModelRowList } from '../vpr/VprModelRows';
import { routerPriceLabel } from '../vpr/VprRouterOptions';
import { InfoTooltip } from '../InfoTooltip';
import modelStyles from './VprModelView.module.scss';
import styles from './VprRouterView.module.scss';

const modelKey = (model: RouterAllowedModel) => JSON.stringify([model.provider, model.serviceId]);

/** Value shown for an option: the saved one, else the router's default. */
function optionValue(spec: RouterOptionSpec, options: RouterOptions | undefined): string | number | boolean | undefined {
  return options?.[spec.key] ?? spec.default;
}

/** Drop an option back to the router's default by removing it; empty options mean "router defaults". */
function withOption(options: RouterOptions | undefined, key: string, value: string | number | boolean | undefined): RouterOptions | undefined {
  const next: RouterOptions = { ...options };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return Object.keys(next).length ? next : undefined;
}

/**
 * One control per setting the router's protocol accepts, from its option specs: a slider for a
 * bounded number, a checkbox for a boolean, a choice for a string with fixed values. The desktop
 * knows no routing protocol; it renders what the router advertises.
 */
function RouterOptionControls({ specs, options, onChange }: {
  specs: readonly RouterOptionSpec[];
  options: RouterOptions | undefined;
  onChange: (next: RouterOptions | undefined) => void;
}) {
  return <>{specs.map(spec => {
    const value = optionValue(spec, options);
    const custom = options?.[spec.key] !== undefined;
    const titleId = `router-option-${spec.key}`;
    let control: JSX.Element | null = null;
    if ((spec.type === 'integer' || spec.type === 'number') && spec.minimum !== undefined && spec.maximum !== undefined) {
      const current = typeof value === 'number' ? value : spec.minimum;
      control = <div className={styles.optionSlider}>
        <VprSlider min={spec.minimum} max={spec.maximum} step={spec.type === 'integer' ? 1 : (spec.maximum - spec.minimum) / 100}
          value={current} ariaLabel={spec.label} onChange={next => onChange(withOption(options, spec.key, next))} />
        <span className={styles.optionValue}>{current}</span>
      </div>;
    } else if (spec.type === 'boolean') {
      control = <input type="checkbox" aria-labelledby={titleId} checked={value === true}
        onChange={event => onChange(withOption(options, spec.key, event.currentTarget.checked))} />;
    } else if (spec.type === 'string' && spec.values?.length) {
      control = <div className={styles.segmented} role="radiogroup" aria-labelledby={titleId}>
        {spec.values.map(choice => <button key={choice} type="button" role="radio" aria-checked={value === choice}
          className={value === choice ? styles.segmentSelected : styles.segment}
          onClick={() => onChange(withOption(options, spec.key, choice))}>{choice}</button>)}
      </div>;
    }
    if (!control) return null;
    return <div key={spec.key} className={styles.settings}>
      <div className={styles.settingText}>
        <h3 id={titleId} className={styles.settingTitle}>{spec.label}</h3>
        {spec.description && <p className={styles.hint}>{spec.description}</p>}
      </div>
      {control}
      <p className={styles.segmentDescription}>
        {custom
          ? <button type="button" className={styles.resetOption} onClick={() => onChange(withOption(options, spec.key, undefined))}>Use the router's default</button>
          : "The router's default."}
      </p>
    </div>;
  })}</>;
}

export function VprRouterView({ service }: { service: RoutingServiceEntry }) {
  const actions = useActions();
  const snapshot = useUiSelector((state) => ({ services: state.vprRoutingServices, selected: state.vprRouteSelection.router,
    rows: state.vprRoutableRows, rowsLoaded: state.chatDiscoverRowsLoaded, error: state.vprRouteError, discoveryError: state.vprRoutingServicesError }), shallowEqual);
  const key = routingServiceKey(service);
  const current = snapshot.services.find((entry) => routingServiceKey(entry) === key);
  const active = !!snapshot.selected && routingServiceKey(snapshot.selected.service) === key;
  const [initialSettings] = useState(() => active ? snapshot.selected : loadVprRouterSettings(service));
  const [routerOptions, setRouterOptions] = useState<RouterOptions | undefined>(initialSettings?.options);
  const [savedAllowedModels, setAllowedModels] = useState<RouterAllowedModel[] | undefined>(initialSettings?.allowedModels);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (!active || !snapshot.selected) return;
    setRouterOptions(snapshot.selected.options);
    setAllowedModels(snapshot.selected.allowedModels);
  }, [active, snapshot.selected]);
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
      actions.updateVprRouterSettings(service, routerOptions, allowedModels);
      setAllowedModels(allowedModels);
      setSaveError(null);
    } catch (error) {
      setSaveError(`Could not save router settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [actions, service, routerOptions, allowedModels, savedAllowedModels]);
  const checkedKeys = useMemo(() => new Set((allowedModels ?? catalog).map(modelKey)), [allowedModels, catalog]);
  const visible = catalog.filter(entry => `${entry.label} ${entry.serviceId} ${entry.provider}`.toLowerCase().includes(search.trim().toLowerCase()));
  const noAvailableModels = !!supported && !catalog.some(model => checkedKeys.has(modelKey(model)));
  function updateSettings(nextOptions: RouterOptions | undefined, nextAllowedModels: RouterAllowedModel[] | undefined): void {
    nextAllowedModels = normalizeRouterAllowedModels(nextAllowedModels, availableModels);
    setRouterOptions(nextOptions);
    setAllowedModels(nextAllowedModels);
    try {
      actions.updateVprRouterSettings(service, nextOptions, nextAllowedModels);
      setSaveError(null);
    } catch (error) {
      setSaveError(`Could not save router settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function toggleModel(provider: string, serviceId: string): void {
    const model = { provider, serviceId };
    const selected = allowedModels ?? catalog.map(({ provider, serviceId }) => ({ provider, serviceId }));
    updateSettings(routerOptions, selected.some(entry => modelKey(entry) === modelKey(model))
      ? selected.filter(entry => modelKey(entry) !== modelKey(model)) : [...selected, model]);
  }
  return <section className={`view view-vpr-model view-pinned-header ${styles.view}`} role="tabpanel">
    <VprPage title="Models" backFallback="explore">
      <div className={styles.stack}>
        <div className={modelStyles.headRow}>
          <div className={modelStyles.headText}>
            <div className={modelStyles.titleLine}>
              <HugeiconsIcon icon={HierarchyIcon} size={20} className={styles.logo} />
              <h1 className={styles.title}>{routerDisplayName(service)}</h1>
            </div>
            <div className={modelStyles.badgeRow}><span className={modelStyles.modelTag}>Router</span><span>{routerSellerName(current ?? service)}</span></div>
          </div>
          <button type="button" className={modelStyles.use} aria-label={active ? 'Selected router' : 'Use router'}
            disabled={active || !current || !supported || !!catalogError || noAvailableModels}
            onClick={() => { if (current) actions.selectVprRouter(current, routerOptions, false, allowedModels); }}>
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
        {!!current?.options?.length && <>
        <h2>Router settings</h2>
        <RouterOptionControls specs={current.options} options={routerOptions} onChange={next => updateSettings(next, allowedModels)} />
        </>}
        <div className={styles.modelHeading}>
          <h2>Allowed models</h2>
          {supported && <label className={styles.allModels}><input type="checkbox" checked={allowedModels === undefined} disabled={!!catalogError || !catalog.length}
            onChange={event => updateSettings(routerOptions, event.currentTarget.checked ? undefined : catalog)} />All supported models</label>}
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
