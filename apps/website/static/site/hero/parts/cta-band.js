// The closing call to action: the Private by design dot field and its ants, drawn in the card (dither.js); the button downloads for the
// visitor's own system, as the homepage's (index.html), a phone getting every system's releases
import { privacyDots } from '../dither.js';
const NAMES = { mac: 'macOS', win: 'Windows', linux: 'Linux' };
export default (slot) => {
  const card = slot.querySelector('.cta-card'); if (!card) return;
  const get = card.querySelector('.cta-get'), ua = navigator.userAgent;
  if (get && /iPhone|iPad|Android/i.test(ua)) { get.href = 'https://github.com/AntSeed/antseed/releases/latest'; get.textContent = 'Download'; }
  else if (get) {
    const os = /Win/.test(ua) ? 'win-x64' : /Linux/.test(ua) ? (/aarch64|arm64/i.test(ua) ? 'linux-arm64' : 'linux-x64') : 'mac-arm64';
    get.href = `https://download.antseed.com/vpr/${os}`; get.textContent = `Download for ${NAMES[os.split('-')[0]]}`;
  }
  // the card's height a whole number of the dots' 16 grid, so its outer dots sit 8 from the top and the bottom as from the sides
  const snap = () => { card.style.minHeight = ''; const h = card.getBoundingClientRect().height; card.style.minHeight = `${Math.ceil(h / 16 - 0.01) * 16}px`; };
  snap(); new ResizeObserver(() => { if (card.getBoundingClientRect().height % 16) snap(); }).observe(card);
  privacyDots(card, { fit: true, step: 16 }).catch((err) => console.warn('cta dots not drawn', err));
};
