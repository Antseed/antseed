import {useColorMode} from '@docusaurus/theme-common';

/** The effective theme ('light' | 'dark'), following Docusaurus' color mode (which sets <html data-theme>). */
export function useSiteTheme(): 'light' | 'dark' {
  return useColorMode().colorMode;
}
