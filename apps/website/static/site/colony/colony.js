// The Colony page: the sign-up links, the TEE answer, and where your Mac fits.
// config.json (beside this file) holds the links that arrive before launch: formUrl (the sign-up form) and communityUrl (optional). Until
// formUrl is set, every sign-up button stays on the page's Sign up block, and its note says when the form opens.
fetch(new URL('config.json', import.meta.url), { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Colony configuration unavailable'))))
  .then((config) => {
    for (const key of ['formUrl', 'communityUrl']) {
      let url = null;
      try { url = config[key] && new URL(config[key]); } catch {}
      if (!url || url.protocol !== 'https:') continue;
      document.querySelectorAll(`[data-colony-link="${key}"]`).forEach((link) => {
        Object.assign(link, { href: url.href, target: '_blank', rel: 'noopener noreferrer', hidden: false });
      });
      document.querySelectorAll(`[data-placeholder-note="${key}"]`).forEach((note) => { note.hidden = true; });
    }
  })
  .catch((err) => console.warn(err.message));

// "Is this a TEE? Read the limits" opens that answer as it scrolls to it
document.querySelectorAll('[data-open]').forEach((link) => link.addEventListener('click', () => {
  const item = document.getElementById(link.dataset.open);
  if (item) item.open = true;
}));

// Where does your Mac fit? Nothing is sent: it only reads the two choices.
const mac = document.getElementById('cl-mac'), mem = document.getElementById('cl-mem'), out = document.getElementById('cl-fit');
if (mac && mem && out) {
  const say = (state, text) => { out.className = `cl-fit-out${state ? ` ${state}` : ''}`; out.querySelector('span').textContent = text; };
  const check = () => {
    const m = mac.value, g = parseInt(mem.value, 10);
    if (!m || !mem.value) return say('', 'Pick your Mac and its memory.');
    if (m === 'Mac Studio' && g >= 512) return say('first', 'The first Colony. 512\u00a0GB is ideal.');
    if (m === 'Mac Studio' && g >= 256) return say('first', 'The first Colony. Mac Studios with 256\u00a0GB or more go first.');
    if (mem.value === 'Not sure') return say('', 'You’ll find it under About This Mac. Sign up either way.');
    return say('later', 'Later Colonies. Sign up and you stay on the list.');
  };
  mac.addEventListener('change', check); mem.addEventListener('change', check);
}
