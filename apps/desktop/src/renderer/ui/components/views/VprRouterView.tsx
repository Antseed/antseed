import { useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { HierarchyIcon, InformationCircleIcon, PreferenceHorizontalIcon } from '@hugeicons/core-free-icons';
import { routerPreferenceDefaults, routerPreferenceError, routingServiceKey, type RouterPreferences, type RouterAllowedModel, type RoutingServiceEntry } from '../../../../shared/routing-selection';
import { useUiSelector, shallowEqual } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { projectRowsToVprModelCatalog } from '../../../modules/catalog/model-catalog';
import { loadVprRouterSettings } from '../../../modules/routing/preferences';
import { VprPage, VprSearch, VprStatRow, VprStatTile } from '../vpr/VprKit';
import { VprFilterDropdown } from '../vpr/VprFilterDropdown';
import { VprModelRowList } from '../vpr/VprModelRows';
import { routerPriceLabel } from '../vpr/VprRouterOptions';
import { InfoTooltip } from '../InfoTooltip';
import modelStyles from './VprModelView.module.scss';
import styles from './VprRouterView.module.scss';

const modelKey = (model: RouterAllowedModel) => JSON.stringify([model.provider, model.serviceId]);

export function VprRouterView({ service }: { service: RoutingServiceEntry }) {
  const actions = useActions();
  const snapshot = useUiSelector((state) => ({ services: state.vprRoutingServices, selected: state.vprRouteSelection.router,
    rows: state.vprRoutableRows, error: state.vprRouteError, discoveryError: state.vprRoutingServicesError }), shallowEqual);
  const key = routingServiceKey(service);
  const current = snapshot.services.find((entry) => routingServiceKey(entry) === key);
  const active = !!snapshot.selected && routingServiceKey(snapshot.selected.service) === key;
  const schema = current?.catalog?.preferencesSchema;
  const [initialSettings] = useState(() => active ? snapshot.selected : loadVprRouterSettings(service));
  const [draft, setDraft] = useState<RouterPreferences | null>(initialSettings ? { ...initialSettings.preferences } : null);
  const defaults = routerPreferenceDefaults(schema);
  const preferences = { ...defaults, ...draft };
  const preferencesError = routerPreferenceError(schema, preferences);
  const [allowedModels, setAllowedModels] = useState<RouterAllowedModel[] | undefined>(initialSettings?.allowedModels);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const supported = current?.catalog;
  const catalogError = current?.catalogError ?? (current?.catalogExpiresAt !== undefined && current.catalogExpiresAt <= Date.now()
    ? 'Router model catalog is stale. Refresh discovery before routing.' : null);
  const catalog = useMemo(() => (supported?.models ?? []).flatMap(model => projectRowsToVprModelCatalog(
    snapshot.rows.filter(row => row.provider === model.provider && row.serviceId === model.serviceId),
  )).filter(entry => entry.kind === 'text'), [snapshot.rows, supported]);
  const checkedKeys = useMemo(() => new Set((allowedModels ?? catalog).map(modelKey)), [allowedModels, catalog]);
  const visible = catalog.filter(entry => `${entry.label} ${entry.serviceId} ${entry.provider}`.toLowerCase().includes(search.trim().toLowerCase()));
  const missing = (allowedModels ?? []).filter(model => !catalog.some(entry => modelKey(entry) === modelKey(model)));
  const unavailable = (supported?.models ?? []).filter(model => !catalog.some(entry => modelKey(entry) === modelKey(model))
    && !missing.some(entry => modelKey(entry) === modelKey(model)));
  const emptySelection = allowedModels?.length === 0;
  const tooManyModels = (allowedModels?.length ?? 0) > 512;
  const noAvailableModels = !!supported && !catalog.some(model => checkedKeys.has(modelKey(model)));
  const label = current?.label ?? service.label;
  function updateSettings(nextPreferences: RouterPreferences, nextAllowedModels: RouterAllowedModel[] | undefined): void {
    setDraft(nextPreferences);
    setAllowedModels(nextAllowedModels);
    try {
      actions.updateVprRouterSettings(service, nextPreferences, nextAllowedModels);
      setSaveError(null);
    } catch (error) {
      setSaveError(`Could not save router settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function toggleModel(provider: string, serviceId: string): void {
    const model = { provider, serviceId };
    const selected = allowedModels ?? catalog.map(({ provider, serviceId }) => ({ provider, serviceId }));
    updateSettings(preferences, selected.some(entry => modelKey(entry) === modelKey(model))
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
            disabled={active || !current || !!catalogError || !!preferencesError || emptySelection || tooManyModels || noAvailableModels}
            onClick={() => { if (current) actions.selectVprRouter(current, preferences, false, allowedModels); }}>
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
        {Object.entries(schema?.properties ?? {}).map(([name, field]) => {
          const label = field.title ?? name;
          const value = preferences[name] ?? '';
          const options = field.enum.map(choice => ({ value: choice, label: choice, icon: <HugeiconsIcon icon={PreferenceHorizontalIcon} size={16} /> }));
          if (!value || (!schema?.required?.includes(name) && field.default === undefined)) options.unshift({ value: '', label: schema?.required?.includes(name) ? 'Choose a value' : 'Not set', icon: <HugeiconsIcon icon={PreferenceHorizontalIcon} size={16} /> });
          if (value && !field.enum.includes(value)) options.unshift({ value, label: `${value} (unavailable)`, icon: <HugeiconsIcon icon={PreferenceHorizontalIcon} size={16} /> });
          return <div className={styles.settings} key={name}>
            <div className={styles.settingText}><h3>{label}</h3>{field.description && <p className={styles.hint}>{field.description}</p>}</div>
            <VprFilterDropdown label={label} value={value} options={options} align="end" onChange={choice => {
              const next = { ...preferences };
              if (choice === '') delete next[name]; else next[name] = choice;
              updateSettings(next, allowedModels);
            }} />
          </div>;
        })}
        {!Object.keys(schema?.properties ?? {}).length && <p className={styles.hint}>This router does not advertise configurable settings.</p>}
        {Object.keys(preferences).filter(name => !schema || !Object.prototype.hasOwnProperty.call(schema.properties, name)).map(name =>
          <div className={styles.settings} key={name}><span>{name}: {preferences[name]} (unavailable)</span><button type="button" onClick={() => {
            const next = { ...preferences }; delete next[name]; updateSettings(next, allowedModels);
          }}>Remove {name}</button></div>)}
        {preferencesError && <p role="alert" className={styles.hint}>{preferencesError}</p>}
        <div className={styles.modelHeading}>
          <h2>Allowed models</h2>
          {supported && <label className={styles.allModels}><input type="checkbox" checked={allowedModels === undefined} disabled={!!catalogError}
            onChange={event => updateSettings(preferences, event.currentTarget.checked ? undefined : [])} />All supported models</label>}
        </div>
        {!supported && !catalogError && <p role="status" className={styles.hint}>This router does not publish its supported models. Support is unknown; requests still restrict recommendations to eligible models.</p>}
        {catalogError && <p role="alert" className={styles.hint}>{catalogError}</p>}
        {supported && <>
        <p className={styles.hint}>Choose which supported models this router can use. If the router returns no allowed model, the request fails.</p>
        <VprSearch value={search} onChange={setSearch} placeholder="Search allowed models" />
        {noAvailableModels && !emptySelection && <p role="status" className={styles.hint}>No selected supported models are currently available.</p>}
        <fieldset disabled={!!catalogError} className={styles.modelChoices}>
          <VprModelRowList entries={visible} checkedKeys={checkedKeys} selectOnly onSelect={toggleModel} emptyLabel="No matching supported models" />
        </fieldset>
        {unavailable.length > 0 && <div className={styles.missing}>
          <p className={styles.hint}>Supported but not currently available</p>
          {unavailable.filter(model => `${model.serviceId} ${model.provider}`.toLowerCase().includes(search.trim().toLowerCase())).map(model =>
            <label key={modelKey(model)} className={styles.allModels}><input type="checkbox" disabled checked={allowedModels === undefined} readOnly />{model.serviceId} · {model.provider} · Unavailable</label>)}
        </div>}
        </>}
        {emptySelection && <p role="alert" className={styles.hint}>Select at least one model or enable All supported models.</p>}
        {tooManyModels && <p role="alert" className={styles.hint}>Select up to 512 models or enable All supported models.</p>}
        {missing.length > 0 && <div className={styles.missing}>
          <p className={styles.hint}>Previously selected models not currently available or supported</p>
          {missing.map(model => <label key={modelKey(model)} className={styles.allModels}>
            <input type="checkbox" checked onChange={() => toggleModel(model.provider, model.serviceId)} />{model.serviceId} · {model.provider}
          </label>)}
        </div>}
        {snapshot.discoveryError && <p role="alert" className={styles.hint}>{snapshot.discoveryError}</p>}
        {!current && <p role="status" className={styles.hint}>This router is unavailable. Wait for discovery or select another model or router.</p>}
        {saveError && <p role="alert" className={styles.hint}>{saveError}</p>}
        {active && snapshot.error && <p role="alert" className={styles.hint}>Could not apply router settings: {snapshot.error}</p>}
      </div>
    </VprPage>
  </section>;
}
