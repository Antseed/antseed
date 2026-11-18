// The night's loops: at night the hero's and the footer's paintings move, a seamless 4.5 s film over each still (the moon's
// glow, the grass, the river, the ants' antennae). Fetched only once it is night, played only while on screen, never with reduced motion;
// the still stays under it until it actually plays, and it fades in over it. The hero's only for Whimsical 2's own night (not ?night=a, c).
// The footer's night loop is the After Effects one, the same 6 s as the day's: the one coming in takes up the other's moment,
// so the theme's crossfade runs between two films in step.
const root = document.documentElement;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
// And by day the footer's own loop: its meadow moving, 6 s, seamless, over its still (an
// image under it, all there is with reduced motion); fetched once the footer nears, WebM where it plays, else MP4, played only while seen.
const videos = [document.querySelector('.whimsical2 .paint:not([data-night]) .night video'), document.querySelector('.s-foot .scene video.night'),
  document.querySelector('.s-foot .scene video.day')].filter(Boolean);

const source = (v) => { if (!v.src) v.src = /\.\w+$/.test(v.dataset.src) ? v.dataset.src : `${v.dataset.src}.${v.canPlayType('video/webm; codecs="vp9"') ? 'webm' : 'mp4'}`; };
const twinOf = (v) => v.closest('.scene')?.querySelector(`video.${v.classList.contains('day') ? 'night' : 'day'}`);   // the footer's other film
const sync = (v) => {
  const day = v.classList.contains('day'), want = (root.dataset.theme === 'dark') !== day && !reduce.matches && v.seen;
  if (want) {
    source(v);
    const twin = twinOf(v);   // in step with it
    if (twin && twin.currentTime && v.paused) { try { v.currentTime = twin.currentTime % (v.duration || 6); } catch {} }
    v.play().catch(() => {});
  } else if (!v.paused) v.pause();
};
const all = () => videos.forEach(sync);

const io = new IntersectionObserver((entries) => entries.forEach((e) => { e.target.seen = e.isIntersecting; sync(e.target); }), { rootMargin: '200px 0px' });
// The footer switches with the page's crossfade, so the other theme must already be there: once the footer's film plays,
// the other one is fetched and held ready (and shown over its still as soon as it has a frame), and the two stills (the day's is a
// lazy image too since, no longer the film's poster) are fetched with the footer's approach, so the fade always has something to fade to
const stills = document.querySelectorAll('.s-foot .scene > img');
for (const v of videos) {
  const foot = !!v.closest('.s-foot');
  v.addEventListener(foot ? 'loadeddata' : 'playing', () => v.classList.add('on'), { once: true });
  if (foot) v.addEventListener('playing', () => { const t = twinOf(v); if (t && !reduce.matches) { t.preload = 'auto'; source(t); } }, { once: true });
  io.observe(v);
}
for (const still of stills) new IntersectionObserver(([e], o) => { if (e.isIntersecting) { still.loading = 'eager'; o.disconnect(); } }, { rootMargin: '600px 0px' }).observe(still);
new MutationObserver(all).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
reduce.addEventListener('change', all);
