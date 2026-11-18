// /ants/: the live figures, from AntSeedStats' API (the client's pages.js): supply and burned ANTS, the epoch and the time to the next one,
// ticking each minute. They count up as they come into view (count.js); when the API does not answer, they stay as the page writes them.
const box = document.querySelector('.s-ants.figs');
const count = await import('/site/hero/count.js');
count.figures(box, 'b[data-tk]');
const write = (k, v) => { const el = box.querySelector(`[data-tk="${k}"]`); if (el && v) (el.matches('b') ? count.set(el, v) : (el.textContent = v)); };
const millions = (v) => `${(v / 1e6).toFixed(1)}M`;
const get = (path) => fetch(`https://antseedstats.com/api/v1/${path}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
get('ants/supply').then(({ data }) => {
  write('supply', data.total_supply_ants > 0 && millions(data.total_supply_ants));
  write('burned', data.burned_ants > 0 && millions(data.burned_ants));
}).catch(() => {});
get('network/summary').then(({ data: { epoch } }) => {
  if (!epoch?.number || !Number.isFinite(epoch.seconds_left)) return;
  write('epoch', `Epoch ${epoch.number}`);
  const deadline = Date.now() + epoch.seconds_left * 1000;
  const tick = () => {
    const s = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    write('next', s ? `Next epoch in ${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h ${Math.floor(s / 60) % 60}m` : 'Awaiting the next epoch');
  };
  tick(); setInterval(tick, 60000);
}).catch(() => {});
