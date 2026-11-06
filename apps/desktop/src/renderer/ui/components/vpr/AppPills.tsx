import { BrandIcon, isThemeAwareAppBrand, resolveBrandKey, type BrandKey } from '@antseed/ui';
import styles from './AppPills.module.scss';

export { styles as appPillStyles };

/** Official marks on a white tile. Zed and Crush keep BrandIcon's drawings until their official files arrive. */
const LOGOS: Partial<Record<BrandKey, string>> = {
  anthropic: new URL('../../../assets/v4/logos/logo-claudecode.svg', import.meta.url).href,
  codex: new URL('../../../assets/v4/logos/logo-codex.svg', import.meta.url).href,
  opencode: new URL('../../../assets/v4/logos/logo-opencode.svg', import.meta.url).href,
  goose: new URL('../../../assets/v4/logos/logo-goose.svg', import.meta.url).href,
  hermes: new URL('../../../assets/v4/logos/logo-hermes.svg', import.meta.url).href,
  pi: new URL('../../../assets/v4/logos/logo-pi.svg', import.meta.url).href,
  droid: new URL('../../../assets/v4/logos/logo-droid.svg', import.meta.url).href,
  t3code: new URL('../../../assets/v4/logos/logo-t3code.svg', import.meta.url).href,
};

export function appLogoUrl(name: string, displayName: string): string | undefined {
  return LOGOS[resolveBrandKey(name, displayName)];
}

/** The brand's v4 logo, else the app's own icon when the desktop extracted one, else its brand mark. */
export function AppPillIcon({ name, displayName, iconDataUri }: { name: string; displayName: string; iconDataUri?: string | null }) {
  const logo = appLogoUrl(name, displayName);
  if (logo) return <img src={logo} alt="" className={styles.appLogo} />;
  return iconDataUri && !isThemeAwareAppBrand(resolveBrandKey(name, displayName))
    ? <img src={iconDataUri} alt="" className={styles.appIcon} />
    : <BrandIcon name={name} hints={[displayName]} size={16} />;
}
