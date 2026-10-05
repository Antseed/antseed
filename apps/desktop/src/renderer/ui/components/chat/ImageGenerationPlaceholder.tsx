import { HugeiconsIcon } from '@hugeicons/react';
import { Image02Icon, Video01Icon } from '@hugeicons/core-free-icons';
import styles from './ImageGenerationPlaceholder.module.scss';

type ImageGenerationPlaceholderProps = {
  editing?: boolean;
  media?: 'image' | 'video';
  phaseLabel?: string | null;
};

export function ImageGenerationPlaceholder({ editing = false, media = 'image', phaseLabel }: ImageGenerationPlaceholderProps) {
  const video = media === 'video';
  const label = video
    ? (phaseLabel || 'Generating video')
    : editing ? 'Editing your image' : 'Generating your image';

  return (
    <div className={`${styles.placeholder}${video ? ` ${styles.video}` : ''}`} role="status" aria-live="polite" aria-label={label}>
      <div className={styles.canvas} aria-hidden="true">
        <div className={styles.glow} />
        <HugeiconsIcon icon={video ? Video01Icon : Image02Icon} size={30} strokeWidth={1.35} className={styles.icon} />
        <div className={styles.shimmer} />
      </div>
      <div className={styles.caption}>
        <span className={styles.pulse} aria-hidden="true" />
        <span>{label}</span>
        {video && <span className={styles.hint}>Video jobs can take a few minutes.</span>}
      </div>
    </div>
  );
}
