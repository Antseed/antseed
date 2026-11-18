// The providers page's band: the figures count up as it comes into view (count.js, as the homepage's band), then take the live values:
// active users from the homepage's models.json, requests, USDC settled and providers from AntSeedStats' API; each kept as written when its
// source does not answer.
const band = document.querySelector('.pp-band');
if (band) {
  const count = import('/site/hero/count.js').then((c) => { c.figures(band, '[data-fig]'); return c; });
  const short = (n, money) => {
    const [d, u] = n >= 1e9 ? [1e9, 'B'] : n >= 1e6 ? [1e6, 'M'] : money && n >= 1e3 ? [1e3, 'K'] : [1, ''];
    return (money ? '$' : '') + (d === 1 ? Math.round(n).toLocaleString('en-US') : (n / d).toFixed(1) + u);
  };
  const fig = (key, n, money) => { const el = band.querySelector(`[data-fig="${key}"]`); if (el && n > 0) count.then((c) => c.set(el, short(n, money))); };
  const json = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
  json('/site/hero/models.json').then(({ network: n }) => fig('users', n?.users)).catch(() => {});
  json('https://antseedstats.com/api/v1/network/summary').then(({ data: { lifetime: l } }) => {
    fig('requests', l.requests); fig('settled', +l.settled_usd, true); fig('providers', l.sellers);
  }).catch(() => {});
}
