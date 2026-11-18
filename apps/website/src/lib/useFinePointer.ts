import {useMediaQuery} from './useMediaQuery';

const QUERY = '(hover: hover) and (pointer: fine)';

/** True on devices with a mouse (a fine pointer that hovers). False during SSR. */
export function useFinePointer(): boolean {
  return useMediaQuery(QUERY);
}
