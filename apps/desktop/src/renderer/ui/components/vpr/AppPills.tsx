import { BrandIcon, isThemeAwareAppBrand, resolveBrandKey } from '@antseed/ui';
import styles from './AppPills.module.scss';

export { styles as appPillStyles };

/** The app's own icon when the desktop extracted one, else its brand mark. */
export function AppPillIcon({ name, displayName, iconDataUri }: { name: string; displayName: string; iconDataUri?: string | null }) {
  return iconDataUri && !isThemeAwareAppBrand(resolveBrandKey(name, displayName))
    ? <img src={iconDataUri} alt="" className={styles.appIcon} />
    : <BrandIcon name={name} hints={[displayName]} size={16} />;
}
