import type {CardFacts} from './cardFacts';

const W = 1200;
const PIXEL = '"Geist Pixel", "Geist Variable", sans-serif';
const SANS = '"Geist Variable", sans-serif';
const MONO = '"Geist Mono Variable", monospace';

const load = (src: string) => new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });

const H = 675;

/** The waitlist card as a PNG, 1200 by 675 so it fits an X post: the dotted page on the left with their waitlist number in large type,
 *  their name and Mac, the painting on the right. */
export async function drawCard({name, mac, number}: CardFacts): Promise<Blob | null> {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  await Promise.all([document.fonts.load(`400 80px ${PIXEL}`), document.fonts.load(`500 24px ${SANS}`), document.fonts.load(`500 20px ${MONO}`)]).catch(() => {});
  const [painting, logo] = await Promise.all([load('/site/assets/colony/join/card.webp'), load('/site/assets/hero/logo.svg')]).catch(() => [] as HTMLImageElement[]);
  const who = name.slice(0, 24);
  const pixel = (size: number) => { g.font = `400 ${size}px ${PIXEL}`; };
  const fit = (text: string, size: number, max: number) => { let z = size; pixel(z); while (z > 24 && g.measureText(text).width > max) pixel(--z); };
  const cover = (im: HTMLImageElement, x: number, y: number, w: number, h: number, fy = .5, fx = .5) => {
    const s = Math.max(w / im.width, h / im.height), sw = w / s, sh = h / s;
    g.drawImage(im, (im.width - sw) * fx, (im.height - sh) * fy, sw, sh, x, y, w, h);
  };
  g.fillStyle = '#fcfcfc'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#e2e2e2';
  for (let y = 4; y < H; y += 8) for (let x = 4; x < 560; x += 8) { g.beginPath(); g.arc(x, y, .9, 0, 7); g.fill(); }
  if (painting) { g.save(); g.beginPath(); g.roundRect(540, 24, W - 564, H - 48, 20); g.clip(); cover(painting, 540, 24, W - 564, H - 48, .6, 1); g.restore(); }
  if (logo) g.drawImage(logo, 64, 60, 128, 44);
  const [model, ...rest] = mac.split(' · ');
  let lead: string;
  let tail = 'wants in.';
  if (who && mac) lead = `${who}’s Mac`;        // "Ada’s Mac wants in."
  else if (who) lead = who;                     // no Mac: "Sam wants in."
  else if (mac) lead = `My ${model}`;           // no name kept: "My MacBook Air wants in."
  else { lead = 'I’m on'; tail = 'the list.'; }
  const detail = who ? mac : rest.join(' · ');
  if (number) {
    // their spot is the headline: "#42", then "Ada’s Mac wants in." and the Mac line
    const spot = `#${number.toLocaleString('en-US')}`;
    const line = `${lead} ${tail}`;
    g.fillStyle = '#4f7a24'; pixel(28); g.fillText('On the Mac Colony waitlist', 64, 196);
    g.fillStyle = '#30382c'; fit(spot, 160, 460); g.fillText(spot, 54, 344);
    g.fillStyle = '#929292'; fit(line, 44, 460); g.fillText(line, 60, 414);
    if (detail) { g.font = `500 24px ${SANS}`; g.fillStyle = '#56656f'; g.fillText(detail, 64, 468); }
  } else {
    g.fillStyle = '#4f7a24'; pixel(28); g.fillText('Mac Colony waitlist', 64, 236);
    g.fillStyle = '#30382c'; fit(lead, 72, 460); g.fillText(lead, 58, 330);
    g.fillStyle = '#929292'; g.fillText(tail, 58, 400);
    if (detail) { g.font = `500 24px ${SANS}`; g.fillStyle = '#56656f'; g.fillText(detail, 64, 460); }
  }
  g.fillStyle = '#4f7a24'; g.font = `500 22px ${MONO}`; g.fillText('antseed.com/colony', 64, H - 64);
  return new Promise((ok) => c.toBlob(ok, 'image/png'));
}
