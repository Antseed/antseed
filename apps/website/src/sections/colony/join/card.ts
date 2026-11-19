/** What the waitlist card shows: their place (or none yet), their first name and their Mac. */
export type CardInfo = {spot: number | null; name: string; mac: string};

const W = 1200, H = 675;
const PIXEL = '"Geist Pixel", "Geist Variable", sans-serif';
const SANS = '"Geist Variable", sans-serif';
const MONO = '"Geist Mono Variable", monospace';

const load = (src: string) => new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });

/** The waitlist card, 1200 by 675 so it fits an X post: the dotted page on the left with their place, the painting on the right. */
export async function drawCard({spot, name, mac}: CardInfo): Promise<Blob | null> {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  await Promise.all([document.fonts.load(`400 80px ${PIXEL}`), document.fonts.load(`500 24px ${SANS}`), document.fonts.load(`500 20px ${MONO}`)]).catch(() => {});
  const [painting, logo] = await Promise.all([load('/site/assets/colony/join/card.webp'), load('/site/assets/hero/logo.svg')]).catch(() => [] as HTMLImageElement[]);
  const place = spot ? `#${spot.toLocaleString('en-US')}` : null;
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
  if (place && who) {
    g.fillStyle = '#4f7a24'; pixel(28); g.fillText('Mac Colony waitlist', 64, 206);
    g.fillStyle = '#929292'; fit(`${who} is`, 60, 460); g.fillText(`${who} is`, 60, 286);
    g.fillStyle = '#30382c'; fit(place, 150, 460); g.fillText(place, 56, 420);
    if (mac) { g.font = `500 24px ${SANS}`; g.fillStyle = '#56656f'; g.fillText(mac, 64, 476); }
  } else {
    const [l1, l2] = [who ? `${who} is on` : 'I’m on', 'the list.'];
    g.fillStyle = '#4f7a24'; pixel(28); g.fillText('Mac Colony waitlist', 64, 236);
    g.fillStyle = '#30382c'; if (place) fit(place, 150, 460); else fit(l1, 72, 460); g.fillText(place || l1, 58, place ? 380 : 330);
    if (!place) { g.fillStyle = '#929292'; g.fillText(l2, 58, 400); }
    if (mac) { g.font = `500 24px ${SANS}`; g.fillStyle = '#56656f'; g.fillText(mac, 64, place ? 440 : 460); }
  }
  g.fillStyle = '#4f7a24'; g.font = `500 22px ${MONO}`; g.fillText('antseed.com/colony', 64, H - 64);
  return new Promise((ok) => c.toBlob(ok, 'image/png'));
}
