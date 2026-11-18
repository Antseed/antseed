// The Gateway's film (Amos, 16 Nov, his revision.js): plays, muted, while on screen; its chapters jump and light with the film, a line
// filling under the one playing; with reduced motion it stays on its poster, with the video's controls.
const film = document.querySelector('.gw-film');
if (film) {
  const video = film.querySelector('video'), chapters = [...film.querySelectorAll('.gw-chapters button')], times = chapters.map((b) => Number(b.dataset.t));
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches || new URLSearchParams(location.search).has('still');
  const light = () => {
    let k = 0;
    times.forEach((t, i) => { if (video.currentTime >= t - 0.05) k = i; });
    chapters.forEach((b, i) => {
      b.setAttribute('aria-pressed', String(i === k));
      const end = times[i + 1] ?? (video.duration || 35);
      b.style.setProperty('--p', i === k ? Math.min(1, (video.currentTime - times[i]) / (end - times[i])) : 0);
    });
  };
  chapters.forEach((b, i) => b.addEventListener('click', () => { video.currentTime = times[i]; video.play().catch(() => {}); light(); }));
  video.addEventListener('timeupdate', light); light();
  if (calm) video.controls = true;
  else new IntersectionObserver(([e]) => { if (e.isIntersecting && !document.hidden) video.play().catch(() => {}); else video.pause(); }, { threshold: 0.4 }).observe(video);
  document.addEventListener('visibilitychange', () => { if (document.hidden) video.pause(); });
}
