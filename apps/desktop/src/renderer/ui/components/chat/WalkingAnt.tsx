import { useEffect, useRef, useState } from 'react';
import styles from './WalkingAnt.module.scss';
import { pickThinkingPhrase } from './thinking-phrases';

type WalkingAntProps = {
  /** A real step of the request (paying, switching mode); shown instead of a meme. */
  phaseLabel?: string | null;
  /** When the request started (ms); the timer counts from it, or from when the ant appeared. */
  startedAt?: number | null;
  /** Seeds the first meme; tests pass it to get stable markup. */
  initialPhrase?: string;
};

/** How often the meme changes while no real step is shown. */
const PHRASE_EVERY_MS = 5_000;
/** The timer stays hidden for quick answers. */
const SHOW_TIMER_AFTER_MS = 2_000;
/** Long enough that a working seller has usually started answering. */
export const SLOW_AFTER_MS = 30_000;
export const SLOW_MESSAGE = 'Still waiting on this provider. You can stop and try another model.';

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

/**
 * A request is on its way and no tokens have arrived yet: a small ant walks
 * beside a rotating meme, or the request's real step when there is one.
 * Screen readers hear only the steady "Thinking" or the real step, never the
 * memes.
 */
export function WalkingAnt({ phaseLabel, startedAt, initialPhrase }: WalkingAntProps) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(mountedAt);
  const [turnPhrase, setTurnPhrase] = useState(() => initialPhrase ?? pickThinkingPhrase());
  const prevPhaseRef = useRef<string | null | undefined>(phaseLabel);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const elapsed = Math.max(0, now - (startedAt ?? mountedAt));

  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phaseLabel;
    if (prev && !phaseLabel) {
      setTurnPhrase((current) => pickThinkingPhrase(current));
    }
  }, [phaseLabel]);

  useEffect(() => {
    if (phaseLabel) return;
    const id = window.setInterval(() => {
      setTurnPhrase((current) => pickThinkingPhrase(current));
    }, PHRASE_EVERY_MS);
    return () => window.clearInterval(id);
  }, [phaseLabel]);

  const slow = elapsed >= SLOW_AFTER_MS;
  const label = slow ? SLOW_MESSAGE : `${phaseLabel ?? turnPhrase}...`;
  const spoken = slow ? SLOW_MESSAGE : `${phaseLabel ?? 'Thinking'}...`;

  /*
   * Original path 4 (legs) split into two independent paths:
   *
   * Left leg: from start (5115,4038) down-left to foot (~4557,2750),
   *   back up to (~5415,3750), then z closes.
   *
   * Right leg: from (~5500,3731) down-right to foot (~5839,2750),
   *   back up to (~5716,4047), then z closes.
   *
   * The connecting top curve between the two legs stays static.
   */
  const legLeft =
    'M5115 4038 c-2 -7 -12 -49 -20 -93 -57 -283 -146 -537 -286 -817 -36 -72 -167 -272 -226 -345 l-26 -33 181 0 180 0 55 98 c165 291 293 610 351 875 6 27 7 27 91 27z';

  const legRight =
    'M5500 3731 c0 -11 14 -81 31 -157 57 -256 125 -451 235 -674 l73 -150 171 0 c93 0 170 2 170 5 0 3 -22 38 -48 78 -173 259 -321 669 -392 1089 -12 67 -23 124 -24 125z';

  // Top connector between legs (static)
  const legConnector =
    'M5415 3750 c77 0 85 -2 85 -19 M5716 4047 c-2 2 -36 -4 -77 -13 -130 -29 -377 -23 -502 12 -9 3 -19 -1 -22 -8';

  return (
    <div className={styles.container}>
      <span className={styles.srOnly} role="status">{spoken}</span>
      <div className={styles.antWrap} aria-hidden="true">
        <svg
          className={styles.ant}
          viewBox="0 0 1024 1024"
          width="28"
          height="28"
          xmlns="http://www.w3.org/2000/svg"
          focusable="false"
        >
          <g transform="translate(0,1024) scale(0.1,-0.1)" fill="#1FD87A" stroke="none">

            {/* Head + antennae */}
            <g className={styles.head}>
              <path d="M6555 7760 c-236 -59 -439 -111 -450 -115 -11 -4 -37 -24 -57 -43
-48 -46 -68 -120 -49 -184 16 -54 100 -209 363 -672 l91 -159 -44 -35 c-119
-96 -219 -231 -258 -348 -29 -85 -39 -254 -21 -347 6 -34 29 -98 49 -142 95
-201 247 -327 493 -410 172 -57 263 -69 513 -69 243 0 310 9 543 69 117 31
357 113 389 133 17 11 -1 143 -38 277 -99 360 -355 671 -683 830 -165 80 -290
116 -488 140 -27 4 -48 10 -48 15 0 7 90 302 94 307 0 1 64 9 141 18 516 63
725 94 754 111 17 10 41 38 52 62 51 103 -18 212 -133 212 -26 0 -147 -14
-270 -30 -665 -90 -696 -96 -746 -143 -34 -32 -41 -47 -92 -202 l-46 -140
-147 247 c-81 135 -147 251 -147 256 0 5 12 12 28 14 140 24 724 164 751 181
45 27 71 73 71 125 0 86 -61 153 -138 151 -26 0 -240 -49 -477 -109z m863
-1584 c86 -45 124 -143 86 -219 -36 -70 -81 -99 -155 -99 -127 1 -204 123
-149 236 39 81 144 120 218 82z" />
            </g>

            {/* Abdomen */}
            <g className={styles.abdomen}>
              <path d="M3588 5699 c-401 -52 -705 -224 -962 -545 -218 -272 -346 -661 -346
-1047 1 -311 91 -642 248 -911 l46 -79 160 7 c259 10 435 42 651 116 495 171
932 567 1099 995 22 55 44 112 50 127 l11 27 87 -55 87 -55 -19 -52 c-159
-458 -502 -839 -956 -1062 -123 -61 -376 -155 -418 -155 -11 0 -17 -2 -14 -5
12 -12 279 28 404 60 348 89 612 233 834 455 135 135 220 251 300 411 153 304
195 617 119 904 -70 267 -255 510 -517 679 -242 157 -558 224 -864 185z m-85
-278 c41 -16 67 -51 67 -91 0 -51 -20 -73 -97 -105 -79 -33 -157 -84 -266
-172 -63 -51 -84 -63 -113 -63 -48 0 -73 15 -90 55 -23 57 -2 100 81 163 160
122 328 222 371 222 12 0 34 -4 47 -9z" />
            </g>

            {/* Thorax */}
            <path d="M5563 5699 c-138 -18 -287 -74 -379 -145 -70 -53 -212 -184 -218
-201 -3 -8 18 -49 48 -91 103 -148 145 -241 186 -412 19 -78 23 -125 24 -265
1 -93 -2 -207 -7 -251 l-7 -82 63 -11 c106 -18 334 -8 375 18 7 4 7 25 -3 71
-7 36 -16 88 -20 116 l-6 51 41 7 c23 4 67 15 98 26 31 11 57 20 58 20 1 0 4
-27 8 -61 19 -187 100 -395 194 -499 91 -101 214 -157 370 -168 l94 -7 29 -98
c77 -258 229 -584 384 -819 l97 -148 179 0 179 0 -71 88 c-249 309 -447 720
-539 1117 -18 77 -34 145 -35 151 -3 8 -24 6 -72 -8 -92 -26 -246 -22 -315 9
-56 25 -137 98 -163 146 l-18 34 55 69 c82 105 116 158 158 247 67 146 109
311 124 494 5 57 4 62 -17 69 -12 3 -59 24 -105 46 -138 65 -268 204 -347 370
l-36 76 -57 15 c-127 36 -224 43 -349 26z" />

            {/* Leg connector (static) */}
            <path d={legConnector} />

            {/* Left leg — tripod group A */}
            <g className={styles.legA}>
              <path d={legLeft} />
            </g>

            {/* Right leg — tripod group B (opposite phase) */}
            <g className={styles.legB}>
              <path d={legRight} />
            </g>

          </g>
        </svg>
      </div>

      <span className={styles.timer} aria-hidden="true">
        {label}
        {elapsed >= SHOW_TIMER_AFTER_MS ? ` · ${formatElapsed(elapsed)}` : null}
      </span>
    </div>
  );
}
