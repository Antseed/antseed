/* The amount a flow carries (10 USDC, 50,000 ANTS…) never sits on the drawing: a copy of its pill rides the flow's head, then goes.
   On a phone the pill's words are hidden, so its coin, not the pill, is what is centred on the line. */

import {PHONE_QUERY} from './phone';

const NS = 'http://www.w3.org/2000/svg';
const LEAVE_MS = 450;   // the copy's fade out (the parts' 0.35s fade) before it is removed

export type Rider = {g: SVGGElement; cx: number; cy: number};

/** Puts a hidden copy of `pill` after `dot`, ready to fade in where `place` first puts it. */
export function mountRider(pill: SVGGElement, dot: SVGCircleElement): Rider {
  const g = document.createElementNS(NS, 'g');
  const copy = pill.cloneNode(true) as SVGGElement;
  ['data-home', 'data-fade', 'data-hidden'].forEach((a) => copy.removeAttribute(a));
  ['data-fade', 'data-hidden', 'data-dot', 'data-rider'].forEach((a) => g.setAttribute(a, ''));
  g.append(copy);
  dot.after(g);
  const box = g.getBBox();
  const rider = {g, cx: box.x + box.width / 2, cy: box.y + box.height / 2};
  const coin = window.matchMedia(PHONE_QUERY).matches ? copy.querySelector<SVGGraphicsElement>('image') : null;
  if (coin) {
    const b = coin.getBBox();
    const m = copy.transform.baseVal.consolidate()?.matrix;
    const centre = new DOMPoint(b.x + b.width / 2, b.y + b.height / 2);
    const at = m ? centre.matrixTransform(m) : centre;
    rider.cx = at.x;
    rider.cy = at.y;
  }
  return rider;
}

export function placeRider(r: Rider, at: DOMPoint): void {
  r.g.setAttribute('transform', `translate(${(at.x - r.cx).toFixed(2)} ${(at.y - r.cy).toFixed(2)})`);
}

/** Fades the copy out and removes it. */
export function dropRider(r: Rider): void {
  r.g.setAttribute('data-hidden', '');
  window.setTimeout(() => r.g.remove(), LEAVE_MS);
}
