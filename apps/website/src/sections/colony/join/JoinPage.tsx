import {useCallback, useEffect, useRef, useState, type FormEvent, type JSX} from 'react';
import clsx from 'clsx';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import {WAITLIST} from '../config';
import {MACS, NO_MAC, chipsFor, memsFor, settle, stepsFor, type Answers, type Step} from './macs';
import {prefillUrl, sourceOf} from './waitlist';
import {macLine, rememberCard} from './cardFacts';
import {JoinBar} from './JoinBar';
import {CardByEmail, JoinGroup, NextSteps} from './Share';
import styles from './JoinPage.module.css';

const TITLE = 'Join the Mac Colony waitlist · Antseed';
const DESCRIPTION = 'A few quick questions about your Mac and you’re on the waitlist for the first Mac Colony.';
const OG_IMAGE = 'https://antseed.com/site/assets/colony/og-waitlist.jpg';
const STEPS: readonly Step[] = ['mac', 'chip', 'memory', 'name', 'review', 'done'];

type Question = {eyebrow: string; title: [string, string]; help: string};
const QUESTIONS: Record<Exclude<Step, 'done'>, Question> = {
  mac: {eyebrow: 'Colony waitlist', title: ['Which Mac would you', 'bring to the Colony?'], help: 'Pick the Mac you’d add. Have more than one? You can sign up the next one after.'},
  chip: {eyebrow: 'Chip', title: ['Which chip', 'is inside?'], help: 'On your Mac, click the Apple logo in the top-left corner of the screen and choose About This Mac. Your chip is next to Chip, for example Apple M2 Pro.'},
  memory: {eyebrow: 'Memory', title: ['How much memory', 'does it have?'], help: 'On your Mac, click the Apple logo in the top-left corner of the screen and choose About This Mac. The size is next to Memory, for example 16 GB.'},
  name: {eyebrow: 'Your name', title: ['What should we', 'call you?'], help: 'Your first name is enough.'},
  review: {eyebrow: 'Last step', title: ['Confirm and', 'lock your spot.'], help: 'We’ll open a short Google form in a new tab. Sign in with Google to confirm your email, then submit. We’ll email you when there’s a spot for your Mac.'},
};

const EMPTY: Answers = {mac: '', chip: '', memory: '', name: ''};
const isStep = (v: unknown): v is Step => typeof v === 'string' && (STEPS as readonly string[]).includes(v);

/** /colony/join/: the Colony waitlist, one question at a time. The Mac, its chip and its memory offer only what Apple shipped (macs.ts),
 *  then the first name; the last step hands off to the Google Form, which collects the verified email, one response per Mac. */
export default function JoinPage(): JSX.Element {
  const [answers, setAnswers] = useState<Answers>(EMPTY);
  const [step, setStep] = useState<Step>('mac');
  const [backwards, setBackwards] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState('');
  const [formError, setFormError] = useState('');
  const [arts, setArts] = useState([{key: 0, art: 'mac' as Step}]);

  const source = useRef('direct');
  const latest = useRef({step, answers});
  latest.current = {step, answers};
  const stepEl = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const firstPaint = useRef(true);

  const go = useCallback((name: Step, {push = true, back = false} = {}) => {
    setBackwards(back);
    setStep(name);
    if (push) history.pushState({colonyStep: name}, '', `${location.search}#${name}`);
  }, []);

  // where they came from and the first history entry; the browser's back button walks the steps
  useEffect(() => {
    source.current = sourceOf(location.search, document.referrer);
    history.replaceState({...history.state, colonyStep: 'mac'}, '', `${location.search}#mac`);
    const onPop = (e: PopStateEvent) => {
      const to: Step = isStep(e.state?.colonyStep) ? e.state.colonyStep : 'mac';
      const {step: from, answers: a} = latest.current;
      const path = stepsFor(a);   // Back walks the steps, and off the flow past the first one (the sign-up finished on Google)
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
    const target = step === 'done' || step === 'review' ? el : step === 'name' ? nameInput.current
      : el?.querySelector<HTMLElement>('[aria-checked="true"]') ?? el?.querySelector<HTMLElement>('[role="radio"]');
    target?.focus({preventScroll: true});
    scrollTo({top: 0, behavior: 'smooth'});
  }, [step]);

  const path = stepsFor(answers);
  const at = path.indexOf(step), questions = path.length - 1, done = step === 'done';
  const nextOf = (a: Answers, from: Step) => { const p = stepsFor(a); return p[p.indexOf(from) + 1]; };
  const joinUrl = prefillUrl(WAITLIST, answers, source.current);

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

  // the last step opens the Google Form, prefilled; Google takes the verified email
  const handoff = () => {
    // every step the Mac needs must be answered: a Mac changed on the summary clears its chip and memory
    if (!answers.mac) { go('mac', {back: true}); return; }
    if (path.includes('chip') && !chipsFor(answers.mac).includes(answers.chip)) { go('chip', {back: true}); return; }
    if (path.includes('memory') && !memsFor(answers.mac, answers.chip).includes(answers.memory)) { go('memory', {back: true}); return; }
    if (!answers.name) { go('name', {back: true}); return; }
    const url = prefillUrl(WAITLIST, answers, source.current);
    if (!url) { setFormError('Sign-ups open soon.'); return; }
    setFormError('');
    rememberCard({name: answers.name, mac: macLine(answers)});   // the first name for the card on /colony/joined/, where the welcome email's link leads
    open(url, '_blank', 'noopener');
    go('done');
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (step === 'name') nameNext();      // Enter in the name field moves on
    else if (step === 'review') handoff();
  };

  const again = () => {
    setAnswers((a) => ({...EMPTY, name: a.name}));   // the name stays filled in
    go('mac');
  };

  const options = (key: 'mac' | 'chip' | 'memory') => key === 'mac' ? [...Object.keys(MACS), NO_MAC]
    : key === 'chip' ? chipsFor(answers.mac) : memsFor(answers.mac, answers.chip);

  const question = !done ? QUESTIONS[step] : null;
  const noMac = answers.mac === NO_MAC;
  // without a Mac there is no spot to wait for: the list keeps them for when there's a way to take part
  const help = step === 'review' && noMac ? 'We’ll open a short Google form in a new tab. Sign in with Google to confirm your email, then submit. We’ll email you when there’s a way for you to take part.'
    : question?.help;
  const title = step === 'review' && noMac ? ['Confirm and', 'join the list.'] : question?.title;

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
        <JoinBar progress={done ? 100 : (at / questions) * 100 + 4} count={done ? 'Done' : `${at + 1} of ${questions}`} live />

        <div className={styles.art} aria-hidden="true">
          {arts.map(({key, art}) => <div key={key} className={styles.artLayer} data-art={art} />)}
        </div>

        <main className={styles.main}>
          <form className={styles.card} noValidate onSubmit={onSubmit}>
            {at > 0 && !done && <button type="button" className={styles.back} onClick={() => history.back()}><span aria-hidden="true">←</span> Back</button>}

            {question && step !== 'done' && (
              <section key={step} ref={stepEl} className={clsx(styles.step, backwards && styles.fromAbove)} data-step={step} tabIndex={step === 'review' ? -1 : undefined}>
                <p className={styles.eyebrow}>{question.eyebrow}</p>
                <h1 className={styles.question}>{title?.[0]}<br /> <span>{title?.[1]}</span></h1>
                <p className={styles.help}>{help}</p>

                {(step === 'mac' || step === 'chip' || step === 'memory') && (() => {
                  const values = options(step);
                  return (
                    <div className={clsx(styles.options, step === 'mac' ? styles.big : styles.chips, values.length <= 3 && styles.few)} role="radiogroup" aria-label={question.eyebrow === 'Colony waitlist' ? 'Your Mac' : question.eyebrow}>
                      {values.map((v, n) => (
                        <button key={v} type="button" role="radio" aria-checked={answers[step] === v} className={clsx(styles.option, v === NO_MAC && styles.none)} onClick={() => pick(step, v)}>
                          {v === NO_MAC ? <span><b>I don’t have a Mac</b><small>I’m into local AI and want to follow along</small></span> : step === 'mac' ? <b>{v}</b> : v}
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

                {step === 'review' && <>
                  <p className={styles.summary}>
                    {([['mac', answers.mac], ['chip', answers.chip], ['memory', answers.memory], ['name', answers.name]] as const).filter(([, v]) => v).map(([k, v]) => (
                      <button key={k} type="button" title="Change" onClick={() => go(path.includes(k) ? k : 'mac', {back: true})}>{v}</button>
                    ))}
                  </p>
                  <p className={styles.error} aria-live="polite">{formError}</p>
                  <div className={styles.go}><button type="submit" className={styles.button} disabled={!joinUrl}>Join the waitlist <span aria-hidden="true">↗</span></button></div>
                </>}
              </section>
            )}

            {done && (
              <section key="done" ref={stepEl} className={clsx(styles.step, styles.done)} data-step="done" tabIndex={-1}>
                <div className={styles.badge} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></div>
                {answers.name && <p className={clsx(styles.eyebrow, styles.hi)}>Thanks, {answers.name}</p>}
                <h1 className={styles.question}>Finish in the<br /> <span>Google tab.</span></h1>
                <p className={styles.help}>We opened a short Google form in a new tab. Sign in there and submit it to {noMac ? 'finish' : 'lock your spot'}.</p>
                {/* a button, not an <a href>: the prefilled URL carries the name and Mac, which the global outbound-click capture would log */}
                {joinUrl && <p className={styles.hint}>Tab didn’t open? <button type="button" className={styles.textLink} onClick={() => open(joinUrl, '_blank', 'noopener')}>Open the form</button>.</p>}
                <JoinGroup />
                <p className={clsx(styles.eyebrow, styles.small)}>Your card</p>
                <CardByEmail />
                <NextSteps />
                <div className={styles.go}>
                  <Link className={styles.skip} to="/colony/">Back to Colony</Link>
                  {!noMac && <button type="button" className={styles.skip} onClick={again}>Sign up another Mac</button>}
                </div>
              </section>
            )}
          </form>
        </main>
      </div>
    </>
  );
}
