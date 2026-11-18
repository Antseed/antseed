// the nav's day/night toggle: the same call as the footer's switch (antseedTheme.set, with its view transition and the 'themechange' the footer and the paintings follow); it flips what is showing
{
const b = document.getElementById('nav-theme'), root = document.documentElement;
// a switch (Elio, 16 Nov: a slider, so one sees the mode can change): on is night
const show = () => b.setAttribute('aria-checked', String(root.dataset.theme === 'dark'));
b.addEventListener('click', () => window.antseedTheme.set(root.dataset.theme === 'dark' ? 'light' : 'dark'));
document.addEventListener('themechange', show); show();
}
