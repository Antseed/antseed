import {useEffect, type RefObject} from 'react';
import {isStill} from '../../../lib/motion';
import {useInView} from '../../../lib/useInView';
import {usePageVisible} from '../../../lib/usePageVisible';
import {POINTS, PROMPT, REPLY} from './script';

const VIEW_THRESHOLD = 0.3;
const TAP_MS = 120;

type Part = 'menu' | 'kimi' | 'private' | 'talk' | 'typed' | 'me' | 'ai' | 'signature' | 'cursor' | 'typedText' | 'replyText';

const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/**
 * The app plays a short story over its captures: the model picker opens and Kimi K3.1 is picked, Private is switched on, a prompt is
 * typed and sent, a signed reply streams in; then it all goes back and starts again. Parts are found by `data-part` under `root` and
 * shown with `data-on`. Runs only while 30% of the app is on screen, the tab is visible and motion is allowed; otherwise the first
 * state stays.
 */
export function useDesktopLoop(root: RefObject<HTMLElement | null>): void {
  const seen = useInView(root, {threshold: VIEW_THRESHOLD});
  const visible = usePageVisible();
  const active = seen && visible;

  useEffect(() => {
    const el = root.current;
    if (!el || !active || isStill()) return;
    const part = (name: Part) => el.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
    const p = {
      menu: part('menu'), kimi: part('kimi'), priv: part('private'), talk: part('talk'), typed: part('typed'), me: part('me'),
      ai: part('ai'), sig: part('signature'), cur: part('cursor'), text: part('typedText'), reply: part('replyText'),
    };
    let alive = true;
    const show = (e: HTMLElement, on = true) => e.toggleAttribute('data-on', on);
    const move = ([x, y]: readonly number[]) => { p.cur.style.setProperty('--x', `${x}px`); p.cur.style.setProperty('--y', `${y}px`); };
    const tap = async () => {
      p.cur.toggleAttribute('data-tap', true); p.cur.style.setProperty('--press', '.86'); await wait(TAP_MS);
      p.cur.style.setProperty('--press', '1'); await wait(TAP_MS); p.cur.toggleAttribute('data-tap', false);
    };
    const reset = () => {
      [p.menu, p.kimi, p.priv, p.talk, p.typed, p.me, p.ai, p.sig, p.cur].forEach((e) => show(e, false));
      p.text.textContent = ''; p.reply.textContent = ''; move(POINTS.rest);
    };

    (async () => {
      reset(); await wait(600);
      while (alive) {
        show(p.cur); await wait(300); move(POINTS.picker); await wait(900); if (!alive) break;
        await tap(); show(p.menu); await wait(500); move(POINTS.kimi); await wait(950); if (!alive) break;
        await tap(); show(p.menu, false); show(p.kimi); await wait(600); move(POINTS.privateSwitch); await wait(1000); if (!alive) break;
        await tap(); show(p.priv); await wait(900); move(POINTS.input); await wait(900); if (!alive) break;
        await tap(); show(p.typed);
        for (let n = 1; n <= PROMPT.length && alive; n++) { p.text.textContent = PROMPT.slice(0, n); await wait(38 + Math.random() * 40); }
        await wait(350); move(POINTS.send); await wait(800); if (!alive) break;
        await tap(); show(p.typed, false); p.text.textContent = ''; show(p.talk); await wait(250); show(p.me); await wait(700);
        show(p.cur, false); show(p.ai);
        const words = REPLY.split(' ');
        for (let n = 1; n <= words.length && alive; n++) { p.reply.textContent = words.slice(0, n).join(' '); await wait(55 + Math.random() * 60); }
        show(p.sig); await wait(3600); if (!alive) break;
        [p.me, p.ai, p.sig].forEach((e) => show(e, false)); await wait(400);
        [p.talk, p.priv, p.kimi].forEach((e) => show(e, false)); await wait(900);
        p.reply.textContent = ''; move(POINTS.rest); await wait(800);
      }
    })();
    return () => { alive = false; reset(); };
  }, [root, active]);
}
