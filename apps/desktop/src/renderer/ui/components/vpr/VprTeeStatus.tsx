import { isFreshSellerNodeEvidence, type TeeEvidence } from '@antseed/node/tee-status';
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

export function VprTeeStatus({ evidence, now, checking, available, error, className }: Props) {
  if (!available || checking || error || !isFreshSellerNodeEvidence(evidence, now)) return null;
  return (
    <div className={className}>
      <InfoTooltip align="left" content={TEE_DESCRIPTION}>
        <span tabIndex={0} className={styles.badge} aria-label={`TEE. ${TEE_DESCRIPTION}`}>
          <span className={modelRowStyles.modelTag}>TEE</span>
        </span>
      </InfoTooltip>
    </div>
  );
}
