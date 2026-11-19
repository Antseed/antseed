import {useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type JSX} from 'react';
import clsx from 'clsx';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import {TELEGRAM_URL, WAITLIST} from '../config';
import {MACS, chipsFor, memoryGb, memsFor, settle, stepsFor, type Answers, type Step} from './macs';
import {newCode, sourceOf, spotOf, waitlistSink, type Row, type Sink} from './waitlist';
import {drawCard} from './card';
import styles from './JoinPage.module.css';

const TITLE = 'Join the Mac Colony waitlist · Antseed';
const DESCRIPTION = 'A few quick questions about your Mac and you’re on the waitlist for the first Mac Colony.';
const OG_IMAGE = 'https://antseed.com/site/assets/colony/og-waitlist.png';
const PAGE_URL = 'https://antseed.com/colony/';
const STEPS: readonly Step[] = ['mac', 'chip', 'memory', 'name', 'email', 'done'];
/** The steps that move someone up the list (the sheet's script weighs them; friends who join count too). */
const MOVES = new Set(['telegram', 'x', 'github']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** A sample place in line for a local review, where no sheet answers. */
const SAMPLE_SPOT = 128;

type Question = {eyebrow: string; title: [string, string]; help: string};
const QUESTIONS: Record<Exclude<Step, 'done'>, Question> = {
  mac: {eyebrow: 'Colony waitlist', title: ['Which Mac would you', 'bring to the Colony?'], help: 'Pick the Mac you’d add. Have more than one? You can sign up the next one after.'},
  chip: {eyebrow: 'Chip', title: ['Which chip', 'is inside?'], help: 'On your Mac, click the Apple logo in the top-left corner of the screen and choose About This Mac. Your chip is next to Chip, for example Apple M2 Pro.'},
  memory: {eyebrow: 'Memory', title: ['How much memory', 'does it have?'], help: 'On your Mac, click the Apple logo in the top-left corner of the screen and choose About This Mac. The size is next to Memory, for example 16 GB.'},
  name: {eyebrow: 'Your name', title: ['What should we', 'call you?'], help: 'Your first name is enough. It goes on your waitlist card.'},
  email: {eyebrow: 'Last step', title: ['Where should we', 'send your invite?'], help: 'One email when there’s a spot for your Mac. Nothing else.'},
};

const EMPTY: Answers = {mac: '', chip: '', memory: '', name: ''};
const macLine = (a: Pick<Answers, 'mac' | 'chip' | 'memory'>) => [a.mac, a.chip, a.memory].filter(Boolean).join(' · ');
const isStep = (v: unknown): v is Step => typeof v === 'string' && (STEPS as readonly string[]).includes(v);

/** /colony/join/: the Colony waitlist, one question at a time. The Mac, its chip and its memory offer only what Apple shipped (macs.ts),
 *  then the first name and the email; the done screen shows the place in line, the card to share and the steps that move them up. */
export default function JoinPage(): JSX.Element {
  const [answers, setAnswers] = useState<Answers>(EMPTY);
  const [step, setStep] = useState<Step>('mac');
  const [backwards, setBackwards] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState('');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [sending, setSending] = useState(false);
  const [spot, setSpot] = useState<number | null>(null);
  const [moved, setMoved] = useState(0);
  const [row, setRow] = useState<Row | null>(null);
  const [code, setCode] = useState('');
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [card, setCard] = useState<{blob: Blob; url: string} | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [arts, setArts] = useState([{key: 0, art: 'mac' as Step}]);

  const sink = useRef<Sink | null>(null);
  const preview = useRef(false);
  const source = useRef('direct');
  const latest = useRef({step, answers, spot, code, ticked});
  latest.current = {step, answers, spot, code, ticked};
  const stepEl = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const firstPaint = useRef(true);

  const go = useCallback((name: Step, {push = true, back = false} = {}) => {
    setBackwards(back);
    setStep(name);
    if (push) history.pushState({colonyStep: name}, '', `${location.search}#${name}`);
  }, []);

  // the sink, where they came from and the first history entry; the browser's back button walks the steps
  useEffect(() => {
    sink.current = waitlistSink(WAITLIST);
    preview.current = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) || new URLSearchParams(location.search).has('preview');
    source.current = sourceOf(location.search, document.referrer);
    history.replaceState({...history.state, colonyStep: 'mac'}, '', `${location.search}#mac`);
    const onPop = (e: PopStateEvent) => {
      const to: Step = isStep(e.state?.colonyStep) ? e.state.colonyStep : 'mac';
      const {step: from, answers: a} = latest.current;
      if (from === 'done' && to !== 'done') { go('done'); return; }   // no going back into a sent form
      const path = stepsFor(a);
      go(to, {push: false, back: path.indexOf(to) < path.indexOf(from)});
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [go]);

  // each step: its painting crossfades in, the cursor goes to its answer, the page goes back to the top
  useEffect(() => {
    setArts((list) => (list[list.length - 1].art === step ? list : [...list.slice(-1), {key: list[list.length - 1].key + 1, art: step}]));
    if (firstPaint.current) { firstPaint.current = false; return; }
    const el = stepEl.current;
    const target = step === 'done' ? el : step === 'email' ? emailInput.current : step === 'name' ? nameInput.current
      : el?.querySelector<HTMLElement>('[aria-checked="true"]') ?? el?.querySelector<HTMLElement>('[role="radio"]');
    target?.focus({preventScroll: true});
    scrollTo({top: 0, behavior: 'smooth'});
  }, [step]);

  // the card follows their place in line
  useEffect(() => {
    if (step !== 'done' || !row) return;
    let live = true;
    drawCard({spot, name: row.name, mac: macLine(row)}).then((blob) => {
      if (live && blob) setCard((old) => { if (old) URL.revokeObjectURL(old.url); return {blob, url: URL.createObjectURL(blob)}; });
    });
    return () => { live = false; };
  }, [step, row, spot]);

  const path = stepsFor(answers);
  const at = path.indexOf(step), questions = path.length - 1, done = step === 'done';
  const nextOf = (a: Answers, from: Step) => { const p = stepsFor(a); return p[p.indexOf(from) + 1]; };

  // picking moves on by itself; a new Mac clears the chip and memory, a new chip the memory
  const pick = (key: 'mac' | 'chip' | 'memory', value: string) => {
    let next = {...answers};
    if (next[key] !== value) {
      next[key] = value;
      if (key === 'mac') { next.chip = ''; next.memory = ''; }
      if (key === 'chip') next.memory = '';
    }
    next = settle(next);
    setAnswers(next);
    setTimeout(() => go(nextOf(next, key)), 200);
  };

  // keyboard: 1 to 9 pick
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as Element)?.matches?.('input, textarea')) return;
      const n = parseInt(e.key, 10);
      if (!(n >= 1 && n <= 9)) return;
      const button = stepEl.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[n - 1];
      if (button) { e.preventDefault(); button.click(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const nameNext = () => {
    const v = nameDraft.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!v) { setNameError('Add your first name to go on.'); nameInput.current?.focus(); return; }
    setNameError(''); setNameDraft(v);
    const next = {...answers, name: v};
    setAnswers(next);
    go(nextOf(next, 'name'));
  };

  const send = async () => {
    if (sending) return;
    const address = email.trim();
    if (!EMAIL.test(address)) { setEmailError('That email doesn’t look right.'); emailInput.current?.focus(); return; }
    if (!answers.mac) { go('mac', {back: true}); return; }
    if (!answers.name) { go('name', {back: true}); return; }
    setEmailError(''); setSending(true);
    let c = code;
    if (!c || row?.email !== address) { c = newCode(); setTicked(new Set()); }
    const gb = memoryGb(answers);
    const r: Row = {email: address, name: answers.name, mac: answers.mac, chip: answers.chip, memory: answers.memory, gb: gb ?? '', source: source.current, code: c};
    let place: number | null = null;
    try {
      const res = await sink.current?.send(r);
      place = spotOf(res);
      if (typeof res?.code === 'string' && /^[a-z0-9]{4,12}$/.test(res.code)) c = res.code;   // already on the list: their first code
    } catch { /* the place stays unknown */ }
    if (!place && preview.current) place = SAMPLE_SPOT;
    try {
      const all = JSON.parse(localStorage.getItem('antseed-colony-waitlist') || '[]');
      all.push({...r, code: c, spot: place, at: new Date().toISOString()});
      localStorage.setItem('antseed-colony-waitlist', JSON.stringify(all));
    } catch { /* storage off: nothing to keep */ }
    setSending(false); setRow(r); setCode(c); setSpot(place);
    go('done');
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (step === 'name') nameNext();   // Enter in the name field moves on
    else if (step === 'email') void send();
  };

  // a step done: the sheet counts it once and answers with the new place in line (a local review moves the sample number)
  const tick = async (name: string) => {
    if (latest.current.ticked.has(name)) return;
    const next = new Set(latest.current.ticked).add(name);
    latest.current.ticked = next;
    setTicked(next);
    let r = {};
    try { r = (await sink.current?.step?.(name, latest.current.code)) || {}; } catch { /* not counted */ }
    let place = spotOf(r);
    const now = latest.current.spot;
    if (!place && preview.current && now && MOVES.has(name)) place = Math.max(1, now - 3);
    if (place && place !== now) { setSpot(place); setMoved((m) => m + 1); }
  };

  const shareUrl = `${PAGE_URL}?ref=${code || 'share'}`;
  const shareText = (spot ? `I’m #${spot.toLocaleString('en-US')} on the waitlist for the first Mac Colony on @AntSeed.` : 'I just joined the waitlist for the first Mac Colony on @AntSeed.') + ' Macs pooled into one AI provider.';
  const save = () => {
    if (!card) return;
    const a = document.createElement('a');
    a.href = card.url; a.download = 'mac-colony-waitlist.png'; a.click();
  };
  const share = async () => {
    void tick('share');
    const file = card && new File([card.blob], 'mac-colony-waitlist.png', {type: 'image/png'});
    // a phone shares the picture itself; a desktop saves it and opens X with the words and the link, ready for the picture
    if (file && navigator.canShare?.({files: [file]}) && matchMedia('(hover: none)').matches) {
      try { await navigator.share({files: [file], text: shareText, url: shareUrl}); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
    }
    save();
    open(`https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`, '_blank', 'noopener');
  };
  const copyLink = async () => {
    void tick('invite');
    try { await navigator.clipboard.writeText(shareUrl); setCopy('copied'); setTimeout(() => setCopy('idle'), 1800); } catch { setCopy('failed'); }
  };
  const again = () => {
    setAnswers((a) => ({...EMPTY, name: a.name}));   // the name and the email stay filled in
    go('mac');
  };

  const options = (key: 'mac' | 'chip' | 'memory') => key === 'mac' ? Object.keys(MACS)
    : key === 'chip' ? chipsFor(answers.mac) : memsFor(answers.mac, answers.chip);

  const question = !done ? QUESTIONS[step] : null;
  const emailTitle: [string, string] = answers.name ? ['Where should we send', `your invite, ${answers.name}?`] : QUESTIONS.email.title;
  const progress = {width: `${done ? 100 : (at / questions) * 100 + 4}%`} as CSSProperties;

  return (
    <>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:image" content={OG_IMAGE} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="675" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:site" content="@antseed" />
        <meta name="twitter:image" content={OG_IMAGE} />
        <link rel="icon" href="/site/assets/home/icons/ant-mark.svg" />
      </Head>
      <div className={styles.page} data-cmp="colony/join-flow">
        <header className={styles.bar}>
          <Link className={styles.logo} to="/colony/" aria-label="Antseed Colony"><img src="/site/assets/hero/logo.svg" width={95} height={33} alt="Antseed" /></Link>
          <div className={styles.progress} aria-hidden="true"><i className={styles.progressFill} style={progress} /></div>
          <p className={styles.count} aria-live="polite">{done ? 'Done' : `${at + 1} of ${questions}`}</p>
          <Link className={styles.close} to="/colony/" aria-label="Close and go back to Colony">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </Link>
        </header>

        <div className={styles.art} aria-hidden="true">
          {arts.map(({key, art}) => <div key={key} className={styles.artLayer} data-art={art} />)}
        </div>

        <main className={styles.main}>
          <form className={styles.card} noValidate onSubmit={onSubmit}>
            {at > 0 && !done && <button type="button" className={styles.back} onClick={() => history.back()}><span aria-hidden="true">←</span> Back</button>}

            {question && step !== 'done' && (
              <section key={step} ref={stepEl} className={clsx(styles.step, backwards && styles.fromAbove)} data-step={step}>
                <p className={styles.eyebrow}>{question.eyebrow}</p>
                <h1 className={styles.question}>{(step === 'email' ? emailTitle : question.title)[0]}<br /> <span>{(step === 'email' ? emailTitle : question.title)[1]}</span></h1>
                <p className={styles.help}>{question.help}</p>

                {(step === 'mac' || step === 'chip' || step === 'memory') && (() => {
                  const values = options(step);
                  return (
                    <div className={clsx(styles.options, step === 'mac' ? styles.big : styles.chips, values.length <= 3 && styles.few)} role="radiogroup" aria-label={question.eyebrow === 'Colony waitlist' ? 'Your Mac' : question.eyebrow}>
                      {values.map((v, n) => (
                        <button key={v} type="button" role="radio" aria-checked={answers[step] === v} className={styles.option} onClick={() => pick(step, v)}>
                          {step === 'mac' ? <b>{v}</b> : v}
                          {n < 9 && <kbd className={styles.key}>{n + 1}</kbd>}
                        </button>
                      ))}
                    </div>
                  );
                })()}

                {step === 'name' && <>
                  <label className={styles.field}><span className={styles.hidden}>First name</span>
                    <input ref={nameInput} type="text" name="name" autoComplete="given-name" autoCapitalize="words" spellCheck={false} maxLength={40} placeholder="First name" enterKeyHint="next"
                      value={nameDraft} onChange={(e) => { setNameDraft(e.target.value); setNameError(''); }} />
                  </label>
                  <p className={styles.error} aria-live="polite">{nameError}</p>
                  <div className={styles.go}><button type="button" className={styles.button} onClick={nameNext}>Continue <span aria-hidden="true">→</span></button></div>
                </>}

                {step === 'email' && <>
                  <p className={styles.summary}>
                    {([['mac', answers.mac], ['chip', answers.chip], ['memory', answers.memory], ['name', answers.name]] as const).filter(([, v]) => v).map(([k, v]) => (
                      <button key={k} type="button" title="Change" onClick={() => go(path.includes(k) ? k : 'mac', {back: true})}>{v}</button>
                    ))}
                  </p>
                  <label className={styles.field}><span className={styles.hidden}>Email</span>
                    <input ref={emailInput} type="email" name="email" autoComplete="email" inputMode="email" placeholder="you@example.com" required
                      value={email} onChange={(e) => { setEmail(e.target.value); setEmailError(''); }} />
                  </label>
                  <p className={styles.error} aria-live="polite">{emailError}</p>
                  <div className={styles.go}><button type="submit" className={styles.button} disabled={sending}>{sending ? 'Joining…' : 'Join the waitlist'} <span aria-hidden="true">→</span></button></div>
                </>}
              </section>
            )}

            {done && (
              <section key="done" ref={stepEl} className={clsx(styles.step, styles.done)} data-step="done" tabIndex={-1}>
                <div className={styles.badge} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></div>
                {row?.name && <p className={clsx(styles.eyebrow, styles.hi)}>Welcome, {row.name}</p>}
                <h1 key={moved} className={clsx(styles.question, moved > 0 && styles.up)}>
                  {spot ? <>You’re <b>#{spot.toLocaleString('en-US')}</b><br /> <span>on the waitlist.</span></> : <>You’re on<br /> <span>the waitlist.</span></>}
                </h1>
                <p className={styles.help}>We’ll email you when there’s a spot for your Mac.</p>
                <figure className={styles.cardImage}>
                  {card ? <img src={card.url} alt="Your Mac Colony waitlist card" width={1200} height={675} /> : <div className={styles.cardWait} />}
                  <figcaption className={styles.go}>
                    <button type="button" className={styles.button} onClick={() => void share()}>Share your spot <span aria-hidden="true">↗</span></button>
                    <button type="button" className={clsx(styles.button, styles.ghost)} onClick={() => { save(); void tick('share'); }}>Save image</button>
                  </figcaption>
                  <p className={styles.hint}>On X, attach the image you saved. Your link is in the post, so friends who join count for you.</p>
                </figure>
                <p className={clsx(styles.eyebrow, styles.small)}>Move up the list</p>
                <ol className={styles.next}>
                  <li className={clsx(ticked.has('telegram') && styles.ticked)}>
                    <div><b>Join the Anthill on Telegram</b><span>Our local AI group. Setups, models and the first Mac Colony, with the team.</span></div>
                    {TELEGRAM_URL
                      ? <a className={clsx(styles.button, styles.sm)} href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer" onClick={() => void tick('telegram')}>Join</a>
                      : <span className={styles.soon}>Opens on launch day</span>}
                  </li>
                  <li>
                    <div><b>Invite friends with your link</b><span>Each friend who joins moves you up.</span><code className={styles.link}>{shareUrl.replace(/^https:\/\//, '')}</code></div>
                    <button type="button" className={clsx(styles.button, styles.sm)} onClick={() => void copyLink()}>{copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Select the link' : 'Copy link'}</button>
                  </li>
                  <li className={clsx(ticked.has('x') && styles.ticked)}>
                    <div><b>Follow @AntSeed on X</b><span>News lands there first.</span></div>
                    <a className={clsx(styles.button, styles.sm, styles.ghost)} href="https://x.com/intent/follow?screen_name=AntSeed" target="_blank" rel="noopener noreferrer" onClick={() => void tick('x')}>Follow</a>
                  </li>
                  <li className={clsx(ticked.has('github') && styles.ticked)}>
                    <div><b>Star Antseed on GitHub</b><span>Everything we build is open.</span></div>
                    <a className={clsx(styles.button, styles.sm, styles.ghost)} href="https://github.com/Antseed/antseed" target="_blank" rel="noopener noreferrer" onClick={() => void tick('github')}>Star</a>
                  </li>
                </ol>
                <div className={styles.go}>
                  <Link className={styles.skip} to="/colony/">Back to Colony</Link>
                  <button type="button" className={styles.skip} onClick={again}>Sign up another Mac</button>
                </div>
              </section>
            )}
          </form>
        </main>
      </div>
    </>
  );
}
