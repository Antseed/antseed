import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, HierarchyIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import { routingServiceKey, type RoutingServiceEntry } from '../../../../shared/routing-selection';
import { useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import styles from '../chat/VprModelDropdown.module.scss';
import rowStyles from './VprModelRows.module.scss';

export function routerPriceLabel(priceMicroUsdc: string): string {
  const price = Number(priceMicroUsdc) / 1_000_000;
  return price === 0 ? 'Free' : `$${price.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function VprRouterRow({ service, active = false, menu = false, chat = false, onClick }: {
  service: RoutingServiceEntry; active?: boolean; menu?: boolean; chat?: boolean; onClick: () => void;
}) {
  if (chat) return <button type="button" role="option" aria-selected={active}
    className={`${styles.modelDropdownItem}${active ? ` ${styles.active}` : ''}`} onClick={onClick}>
    <span className={styles.itemTopRow}>
      <span className={styles.itemNameGroup}>
        <HugeiconsIcon icon={HierarchyIcon} size={16} className={rowStyles.logo} />
        <span className={styles.itemName} title={service.label}>{service.label}</span>
      </span>
      <span className={styles.itemPricing}>{routerPriceLabel(service.priceMicroUsdc)}{Number(service.priceMicroUsdc) > 0 && ' / request'}</span>
    </span>
    <span className={styles.itemMeta}>
      <span className={rowStyles.peerMeta} title={service.provider}>{service.provider}</span>
      <span className={styles.imageBadge}>Router</span>
    </span>
  </button>;
  return <button type="button" role={menu ? 'option' : undefined} aria-selected={menu ? active : undefined}
    aria-pressed={!menu ? active : undefined} className={`${rowStyles.row}${menu ? ` ${rowStyles.rowDense}` : ''}`} onClick={onClick}>
    {active && <span className={rowStyles.checkSlot} aria-hidden="true"><HugeiconsIcon icon={Tick02Icon} size={16} className={rowStyles.check} /></span>}
    <span className={rowStyles.rowMain}>
      <span className={rowStyles.titleLine}>
        <HugeiconsIcon icon={HierarchyIcon} size={16} className={rowStyles.logo} />
        <span className={rowStyles.label} title={service.label}>{service.label}</span>
        <span className={rowStyles.modelTag}>Router</span>
      </span>
      <span className={rowStyles.metaLine}>
        <span className={rowStyles.peerMeta} title={service.provider}>{service.provider}</span>
        <span className={rowStyles.metaDivider} aria-hidden="true">·</span>
        <span className={rowStyles.metaPrice}>{routerPriceLabel(service.priceMicroUsdc)}{Number(service.priceMicroUsdc) > 0 && <> <span className={rowStyles.perTok}>/ request</span></>}</span>
      </span>
    </span>
    {!menu && <HugeiconsIcon icon={ArrowRight01Icon} size={16} className={rowStyles.chevron} />}
  </button>;
}

export function VprRouterOptions({ forConversation = false, routerActive = true, onSelect }: { forConversation?: boolean; routerActive?: boolean; onSelect?: () => void }) {
  const services = useUiSelector((state) => state.vprRoutingServices);
  const selected = useUiSelector((state) => state.vprRouteSelection.router);
  const error = useUiSelector((state) => state.vprRouteError);
  const discoveryError = useUiSelector((state) => state.vprRoutingServicesError);
  const actions = useActions();
  const selectedKey = selected ? routingServiceKey(selected.service) : null;
  if (services.length === 0 && !(selected && routerActive) && !discoveryError && !error) return null;
  return <><div role="group" aria-label="Routing services">
    <div className={styles.modelDropdownSection}>Routers</div>
    {discoveryError && <div className={styles.modelDropdownItem} role="alert">{discoveryError}</div>}
    {services.map((service) => {
      const selectedService = routingServiceKey(service) === selectedKey;
      return <VprRouterRow key={routingServiceKey(service)} service={service} menu chat={forConversation} active={routerActive && selectedService}
        onClick={() => { actions.selectVprRouter(service, selectedService ? selected!.costQualityTradeoff : undefined, forConversation, selectedService ? selected!.allowedModels : undefined); onSelect?.(); }} />;
    })}
    {selected && routerActive && !services.some((service) => routingServiceKey(service) === selectedKey) &&
      <div className={styles.modelDropdownItem} role="status">Selected router unavailable. Retry discovery or select a model.</div>}
    {error && <div className={styles.modelDropdownItem} role="alert">{error}</div>}
  </div>
    <div className={styles.modelDropdownSection}>Models</div>
  </>;
}
