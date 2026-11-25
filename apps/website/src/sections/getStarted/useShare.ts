import {useCopy} from '../../lib/useCopy';

/** Shares the page through the system sheet, or copies its link where there is none; `copied` is true for a moment after a copy. */
export function useShare(title: string, path: string): {share: () => Promise<void>; copied: boolean} {
  const {copied, copy} = useCopy();
  const share = async () => {
    const url = `${window.location.origin}${path}`;
    if (!navigator.share) {
      copy(url);
      return;
    }
    try {
      await navigator.share({title, url});
    } catch {
      // the share sheet was dismissed
    }
  };
  return {share, copied};
}
