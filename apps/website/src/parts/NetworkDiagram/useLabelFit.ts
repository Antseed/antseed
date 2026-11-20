import {useEffect, type RefObject} from 'react';
import {collectLabels, fitLabels} from './labels';

/** Keeps the drawings' labels readable at the size the stage is shown (see labels.ts), refitted as the stage resizes. */
export function useLabelFit(stage: RefObject<HTMLElement | null>, drawings: RefObject<(SVGSVGElement | null)[]>): void {
  useEffect(() => {
    const box = stage.current;
    const svgs = drawings.current?.filter((s): s is SVGSVGElement => !!s) ?? [];
    if (!box || !svgs.length) return;
    let frame = 0;
    let cancelled = false;
    let labels: ReturnType<typeof collectLabels>[] = [];
    const fit = () => {
      const scale = svgs[0].getScreenCTM()?.a || 1;
      labels.forEach((l) => fitLabels(l, scale));
    };
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); });
    document.fonts.ready.then(() => {   // labels are measured in their font
      if (cancelled) return;
      labels = svgs.map(collectLabels);
      fit();
      ro.observe(box);
    });
    return () => {
      cancelled = true;
      ro.disconnect();
      cancelAnimationFrame(frame);
      labels.forEach((l) => l.reset());
    };
  }, [stage, drawings]);
}
