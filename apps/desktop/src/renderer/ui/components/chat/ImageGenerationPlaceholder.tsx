import { HugeiconsIcon } from '@hugeicons/react';
import { Image02Icon } from '@hugeicons/core-free-icons';
import styles from './ImageGenerationPlaceholder.module.scss';

type ImageGenerationPlaceholderProps = {
  editing?: boolean;
};

export function ImageGenerationPlaceholder({ editing = false }: ImageGenerationPlaceholderProps) {
  const label = editing ? 'Editing your image' : 'Generating your image';

  return (
    <div className={styles.placeholder} role="status" aria-live="polite" aria-label={label}>
      <div className={styles.canvas} aria-hidden="true">
        <div className={styles.glow} />
        <HugeiconsIcon icon={Image02Icon} size={30} strokeWidth={1.35} className={styles.icon} />
        <div className={styles.shimmer} />
      </div>
      <div className={styles.caption}>
        <span className={styles.pulse} aria-hidden="true" />
        <span>{label}</span>
      </div>
    </div>
  );
}
