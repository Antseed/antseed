import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { SecurityBlockIcon, SecurityCheckIcon, ShieldHalfIcon } from '@hugeicons/core-free-icons';
import { isFreshSellerNodeEvidence, teeScope, type TeeEvidence, type TeeScope } from '@antseed/node/tee-status';
import { InfoTooltip } from '../InfoTooltip';
import modelRowStyles from './VprModelRows.module.scss';
import styles from './VprTeeAvailability.module.scss';

type Props = {
  evidence?: TeeEvidence;
  now: number;
  checking: boolean;
  available: boolean;
  error?: string;
  className?: string;
};

const TEE_DESCRIPTION = 'We use TEEs to enhance user privacy.';

// Like Cloudflare's Flexible vs Full SSL: which hops of the request path are TEE-protected.
const SCOPES: Record<TeeScope, { label: string; icon: IconSvgElement; providerTee: boolean; description: string }> = {
  'end-to-end': {
    label: 'Full TEE',
    icon: SecurityCheckIcon,
    providerTee: true,
    description: TEE_DESCRIPTION,
  },
  'seller-node': {
    label: 'Partial TEE',
    icon: ShieldHalfIcon,
    providerTee: false,
    description: 'Only the seller node runs in a verified TEE. Its upstream model provider is not TEE-attested and may see your requests.',
  },
};

function Hop({ name, tee }: { name: string; tee: boolean }) {
  return (
    <span className={`${styles.hop}${tee ? '' : ` ${styles.hopOpen}`}`}>
      {name}
      <span className={styles.hopStatus}>
        <HugeiconsIcon icon={tee ? SecurityCheckIcon : SecurityBlockIcon} size={13} strokeWidth={2} aria-hidden />
        {tee ? 'TEE' : 'not TEE'}
      </span>
    </span>
  );
}

export function VprTeeStatus({ evidence, now, checking, available, error, className }: Props) {
  if (!available || checking || error || !evidence || !isFreshSellerNodeEvidence(evidence, now)) return null;
  const scope = SCOPES[teeScope(evidence)];
  const content = (
    <span className={styles.scope}>
      <span className={styles.hops}>
        <Hop name="Seller" tee />
        <Hop name="Model provider" tee={scope.providerTee} />
      </span>
      <span>{scope.description}</span>
    </span>
  );
  return (
    <div className={className}>
      <InfoTooltip align="left" content={content}>
        <span tabIndex={0} className={styles.badge} aria-label={`${scope.label}. ${scope.description}`}>
          <span className={`${modelRowStyles.modelTag} ${styles.scopeTag}`}>
            <HugeiconsIcon icon={scope.icon} size={12} strokeWidth={2} aria-hidden />
            {scope.label}
          </span>
        </span>
      </InfoTooltip>
    </div>
  );
}
