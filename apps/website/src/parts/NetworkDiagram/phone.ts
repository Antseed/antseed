/* The board on a phone: the drawing whole and wordless, its parts named by three tags in HTML, each centred under (or over) its cubes. */

export const PHONE_QUERY = '(max-width: 760px)';

const TAG_GAP_BELOW = 6;
const TAG_GAP_ABOVE = 4;
const TAG_INSET = 4;   // a tag never touches the stage's edge

export type PhoneTag = {name: string; cubes: string; above?: boolean; /** Shown only in the step that shows the holders. */ holders?: boolean};

export const PHONE_TAGS: readonly PhoneTag[] = [
  {name: 'Buyers', cubes: '[data-n="Cube / You"], [data-n="Cube / Team workspace"], [data-n="Cube / AI agent"]'},
  {name: 'Providers', cubes: '[data-n^="Cube / Provider"]'},
  {name: 'ANTS holders', cubes: '[data-n="Holders"]', above: true, holders: true},
];

/** Places each tag against the shapes (not the words) of its cubes, in stage pixels. The cubes stand still in every step. */
export function placeTags(stage: HTMLElement, svg: SVGSVGElement, tags: readonly (HTMLElement | null)[]): void {
  const S = stage.getBoundingClientRect();
  PHONE_TAGS.forEach((tag, i) => {
    const el = tags[i];
    if (!el) return;
    let L = Infinity, R = -Infinity, T = Infinity, B = -Infinity;
    for (const group of svg.querySelectorAll(tag.cubes)) {
      for (const shape of group.querySelectorAll(':scope :not(text):not(g):not(tspan)')) {
        const r = shape.getBoundingClientRect();
        if (!r.width) continue;
        L = Math.min(L, r.left); R = Math.max(R, r.right); T = Math.min(T, r.top); B = Math.max(B, r.bottom);
      }
    }
    if (L === Infinity) return;
    const w = el.offsetWidth;
    const left = Math.max(TAG_INSET, Math.min(S.width - w - TAG_INSET, (L + R) / 2 - S.left - w / 2));
    const top = tag.above ? T - S.top - el.offsetHeight - TAG_GAP_ABOVE : B - S.top + TAG_GAP_BELOW;
    el.style.left = `${left.toFixed(1)}px`;
    el.style.top = `${top.toFixed(1)}px`;
  });
}
