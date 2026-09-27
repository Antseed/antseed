/**
 * HeroDemo — the live AI VPN demo animation from the hero prototype
 * (antseed-website.vercel.app), ported 1:1 from its Remotion
 * composition: a 2048×1152 scene at 30 fps over 582 frames.
 *
 * No Remotion dependency: a rAF clock drives the same frame-based
 * interpolations, and the scene scales to its container width.
 * Assets under /img/demo/ are the originals from the prototype.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
} from 'react';

const DEMO_FPS = 30;
export const DEMO_TOTAL_FRAMES = 582;

/* ---------- timeline beats (the prototype's `i9`) ---------- */
export const DEMO_BEATS = {
  offHold: 0,
  powerOnStart: 16,
  powerBtnPressMid: 21,
  powerBtnPressEnd: 27,
  powerBtnOnStart: 18,
  powerBtnOnEnd: 30,
  surfaceStart: 31,
  surfaceEnd: 54,
  powerOnEnd: 54,
  chatLineGrowStart: 64,
  chatLineGrowEnd: 84,
  chatRevealStart: 84,
  chatRevealEnd: 96,
  typingStart: 96,
  msgEnd: 120,
  respStart: 132,
  respEnd: 168,
  reqUpStart: 122,
  reqUpEnd: 146,
  respUpStart: 150,
  respUpEnd: 174,
  modelRevealStart: 190,
  modelRevealEnd: 204,
  rouletteStart: 192,
  rouletteEnd: 220,
  savingLineGrowStart: 212,
  savingLineGrowEnd: 230,
  tokensRevealStart: 230,
  tokensRevealEnd: 244,
  tokensCountStart: 236,
  tokensCountEnd: 264,
  savingFlowStart: 232,
  savingFlowEnd: 256,
  pricePopStart: 272,
  pricePopEnd: 279,
  lowerLineGrowStart: 290,
  lowerLineGrowEnd: 312,
  reqDownStart: 294,
  reqDownEnd: 318,
  anonNodeStart: 298,
  anonNodeEnd: 326,
  networkRevealStart: 314,
  networkRevealEnd: 330,
  anonPopStart: 344,
  anonPopEnd: 351,
  respDownStart: 356,
  respDownEnd: 380,
  chatFadeStart: 388,
  chatFadeEnd: 400,
  webRevealStart: 396,
  webRevealEnd: 410,
  webTypingStart: 414,
  webMsgEnd: 438,
  webRespStart: 450,
  webRespEnd: 486,
  webReqUpStart: 440,
  webReqUpEnd: 464,
  webRespUpStart: 468,
  webRespUpEnd: 492,
  favoritePopStart: 492,
  favoritePopEnd: 499,
  endFlowStart: 500,
  endFlowEnd: 524,
  holdEnd: 542,
  fadeOutStart: 542,
  fadeOutEnd: 562,
  total: 582,
};

const B = DEMO_BEATS;

/* ---------- palette / chrome (verbatim) ---------- */
const RED = '#FF4B59';
const YELLOW = '#FFC600';
const GREEN_DOT = '#00CA48';
const INK = '#001E12';
const MUTED = '#676663';
const WHITE = '#FFFFFF';
const BUBBLE = '#F3F2EF';
const LINE = '#DFDEDB';
const GRAY = '#A3A29F';
const CARD_SHADOW = '0px 2px 10px 0px rgba(17,23,20,0.16)';
const DEMO_FONT = "'Geist Variable', Geist, sans-serif";

/* ---------- easing + interpolate (Remotion-equivalent) ---------- */
const easeOutExp = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

function interp(
  v: number,
  input: number[],
  output: number[],
  easing?: (t: number) => number,
): number {
  let i = 1;
  while (i < input.length - 1 && v > input[i]) i++;
  const a = input[i - 1];
  const b = input[i];
  let t = b === a ? 0 : (v - a) / (b - a);
  t = Math.max(0, Math.min(1, t));
  if (easing) t = easing(t);
  return output[i - 1] + (output[i] - output[i - 1]) * t;
}

/* ---------- frame context ---------- */
const FrameContext = createContext(0);
const useFrame = () => useContext(FrameContext);

/**
 * Manual power-off context. While the user-triggered shutdown runs, the scene
 * frame is frozen (so nothing new appears) and this holds a virtual frame
 * sweeping `fadeOutStart -> fadeOutEnd`. Every fade-out expression is evaluated
 * at that virtual frame instead, so a click replays the loop's own closing beat
 * verbatim — same curves, same duration — from whatever state is on screen.
 */
const ShutdownContext = createContext<number | null>(null);
const useShutdown = () => useContext(ShutdownContext);

/* pop-in: opacity/scale over `dur` frames from `start` */
function popIn(frame: number, start: number, dur = 10) {
  const t = interp(frame, [start, start + dur], [0, 1], easeOutExp);
  return {opacity: t, scale: 0.96 + 0.04 * t, t};
}

/* global fade-out at the end of the loop */
function fadeOut(frame: number) {
  return interp(frame, [B.fadeOutStart, B.fadeOutEnd], [1, 0], easeInOutCubic);
}

/* the loop's fade-out, or the manual shutdown's when one is running */
function useOut() {
  const frame = useFrame();
  const shut = useShutdown();
  return fadeOut(shut ?? frame);
}

function growth(frame: number, start: number, end: number) {
  if (frame < start) return 0;
  if (frame >= end) return 1;
  return interp(frame, [start, end], [0, 1], easeInOutCubic);
}

function phaseT(frame: number, start: number, end: number) {
  return frame < start || frame > end ? null : (frame - start) / (end - start);
}

interface Flow {
  start: number;
  end: number;
  reverse: boolean;
}

/* the flow pulse running at `frame` with its 0..1 progress, if any */
function activeFlow(frame: number, flows: Flow[]): {f: Flow; t: number} | null {
  for (const f of flows) {
    const t = phaseT(frame, f.start, f.end);
    if (t !== null) return {f, t};
  }
  return null;
}

function dashOffset(t: number, dash: number, len: number, reverse: boolean) {
  const total = len + dash;
  return reverse ? -len + t * total : dash - t * total;
}

function pulseFade(t: number) {
  return Math.max(0, Math.min(1, t / 0.14, (1 - t) / 0.14));
}

const asset = (name: string) => `/img/demo/${name}`;

/* ------------------------------------------------------------------
   Mobile composition — one centred column instead of the wide scene.
   The chat windows drop out; what is left is the story of a single
   request, stacked top -> bottom in the order the timeline already
   tells it: the AI VPN, the price it got, the network it got it from.

   Hierarchy comes from nested widths — card 524 < routing pill 580 <
   network bar 636, in even 56px steps — so the card stays the
   dominant object and each outer layer frames the one inside it.
   ------------------------------------------------------------------ */
const M_W = 660;
const M_H = 924;
const M_CX = M_W / 2;

/* Aux elements keep their artwork and are scaled to hit the widths
   above. Their `left`/`top` is the *image* box, solved so the visible
   ink lands centred on M_CX: left = cx - w/2 - (inkCx - w/2) * scale. */
const M_ROUTING_S = 0.788; // 736 ink -> 580, still overhangs the card
const M_TOKENS_S = 0.92; //   454 ink -> 418, the narrowest chip
const M_NETWORK_S = 0.772; // 824 ink -> 636, the widest layer

/* ============================================================
   Chat cards (desktop `i1` / web `i7`)
   ============================================================ */
const PROMPT = 'Find why checkout is failing on mobile and fix it';
const RESPONSE = 'Found it -\nmissing null check in the payment form.\nFixed and verified.';

function WindowDot({color}: {color: string}) {
  return (
    <span
      style={{
        width: 24,
        height: 24,
        borderRadius: '50%',
        backgroundColor: color,
        display: 'inline-block',
        flexShrink: 0,
      }}
    />
  );
}

function Caret() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 3,
        height: 24,
        backgroundColor: INK,
        marginLeft: 2,
        verticalAlign: 'middle',
      }}
    />
  );
}

interface IconProps {
  size: number;
  color: string;
  strokeWidth: number;
}

/* 24-unit stroked icon frame shared by the chat chrome glyphs below */
function StrokeIcon({size, color, strokeWidth, children}: IconProps & {children: ReactNode}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function PlusIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </StrokeIcon>
  );
}

function MicIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M12 19v3" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <rect x="9" y="2" width="6" height="13" rx="3" />
    </StrokeIcon>
  );
}

function ArrowUpIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </StrokeIcon>
  );
}

function GlobeIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="12" r="9.25" />
      <path d="M2.75 12h18.5" />
      <path d="M12 2.75a13.5 13.5 0 0 1 0 18.5 13.5 13.5 0 0 1 0-18.5" />
    </StrokeIcon>
  );
}

function ChevronDownIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="m6 9 6 6 6-6" />
    </StrokeIcon>
  );
}

function ChatApp({
  web,
  style,
}: {
  /** web variant: lock + URL bar header, web timeline beats */
  web?: boolean;
  style?: CSSProperties;
}) {
  const frame = useFrame();
  const typingStart = web ? B.webTypingStart : B.typingStart;
  const msgEnd = web ? B.webMsgEnd : B.msgEnd;
  const respStart = web ? B.webRespStart : B.respStart;
  const respEnd = web ? B.webRespEnd : B.respEnd;

  const typedChars =
    frame >= typingStart
      ? Math.min(PROMPT.length, Math.round(((frame - typingStart) / (msgEnd - typingStart)) * PROMPT.length))
      : 0;
  const respChars =
    frame >= respStart
      ? Math.min(RESPONSE.length, Math.round(((frame - respStart) / (respEnd - respStart)) * RESPONSE.length))
      : 0;
  const thinking = frame >= msgEnd && respChars === 0;
  const thinkingDots = (Math.floor((frame - msgEnd) / 8) % 3) + 1;
  const blink = Math.floor(frame / 15) % 2 === 0;
  const typing = frame >= typingStart && frame < msgEnd;
  const responding = frame >= respStart && frame < respEnd;
  const sent = frame >= msgEnd;

  let composer: ReactNode;
  if (typing) {
    composer = (
      <>
        {PROMPT.slice(0, typedChars)}
        {blink && <Caret />}
      </>
    );
  } else if (frame < typingStart) {
    composer = <>Write a message...{blink ? '|' : ' '}</>;
  } else {
    composer = 'Write a message...';
  }

  return (
    <div
      style={{
        position: 'absolute',
        width: 736,
        height: 532,
        backgroundColor: WHITE,
        borderRadius: 32,
        boxShadow: CARD_SHADOW,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        ...style,
      }}>
      <div style={{display: 'flex', alignItems: 'center', gap: web ? 28 : 32, padding: 32, flexShrink: 0}}>
        <div style={{display: 'flex', gap: 16}}>
          <WindowDot color={RED} />
          <WindowDot color={YELLOW} />
          <WindowDot color={GREEN_DOT} />
        </div>
        {web ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 16,
              backgroundColor: '#F5F7F8',
              borderRadius: 16,
              padding: '14px 24px',
            }}>
            <GlobeIcon size={24} color={MUTED} strokeWidth={2} />
            <span style={{fontSize: 24, fontWeight: 500, color: INK, fontFamily: DEMO_FONT}}>
              Any Agentic Web App
            </span>
          </div>
        ) : (
          <span style={{fontSize: 24, fontWeight: 600, color: INK, fontFamily: DEMO_FONT}}>
            Any Agentic Desktop App
          </span>
        )}
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          gap: 32,
          padding: '0 32px 32px',
        }}>
        {sent && (
          <div style={{alignSelf: 'flex-end', maxWidth: '92%'}}>
            <div style={{backgroundColor: BUBBLE, borderRadius: 24, padding: '16px 28px'}}>
              <span style={{fontSize: 22, color: INK, fontFamily: DEMO_FONT, display: 'block'}}>
                {PROMPT}
              </span>
            </div>
          </div>
        )}
        {thinking && (
          <div style={{paddingLeft: 8, display: 'flex', alignItems: 'center', gap: 10}}>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  backgroundColor: i < thinkingDots ? MUTED : 'transparent',
                  display: 'inline-block',
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
        )}
        {respChars > 0 && (
          <div style={{paddingLeft: 8}}>
            <span
              style={{
                fontSize: 22,
                color: INK,
                lineHeight: '40px',
                fontFamily: DEMO_FONT,
                display: 'block',
                whiteSpace: 'pre-line',
              }}>
              {RESPONSE.slice(0, respChars)}
              {responding && blink && <Caret />}
            </span>
          </div>
        )}
      </div>
      <div style={{padding: '0 32px 32px', flexShrink: 0}}>
        <div
          style={{
            border: `2px solid ${LINE}`,
            borderRadius: 32,
            padding: '24px 24px 24px 32px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}>
          <span style={{fontSize: 22, color: typing ? INK : MUTED, fontFamily: DEMO_FONT, minHeight: 22}}>
            {composer}
          </span>
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
            <PlusIcon size={32} color={MUTED} strokeWidth={1.8} />
            <div style={{display: 'flex', alignItems: 'center', gap: 32}}>
              <MicIcon size={32} color={MUTED} strokeWidth={1.8} />
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 16,
                  backgroundColor: typing ? INK : GRAY,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                <ArrowUpIcon size={32} color="#FFFFFF" strokeWidth={2} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   AI VPN card with power button (`av`)
   ============================================================ */
function VprCard({
  left = 1110,
  top = 108,
  onToggle,
}: {
  left?: number;
  top?: number;
  /** when set, the power button is a real control that toggles the demo */
  onToggle?: () => void;
}) {
  const frame = useFrame();
  const shut = useShutdown();
  const [hover, setHover] = useState(false);

  // How far the loop's own closing beat has run: the manual shutdown drives the
  // exact same curves, just from a virtual frame instead of the scene frame.
  const closing = interp(shut ?? frame, [B.fadeOutStart, B.fadeOutEnd], [1, 0], easeOutExp);
  const powerOn =
    interp(frame, [B.powerBtnOnStart, B.powerBtnOnEnd], [0, 1], easeOutExp) * closing;
  const press =
    interp(
      frame,
      [B.powerOnStart, B.powerBtnPressMid, B.powerBtnPressEnd],
      [1, 0.93, 1],
      easeInOutCubic,
    ) *
    // the off-click gets the same press dip the on-beat has
    (shut !== null ? 1 - 0.07 * Math.sin(Math.min(1, (shut - B.fadeOutStart) / 7) * Math.PI) : 1);
  const surface =
    120 * interp(frame, [B.surfaceStart, B.surfaceEnd], [0, 1], easeInOutCubic);
  const mask = `radial-gradient(circle at 50% 20.2%, #000 ${Math.max(0, surface - 26)}%, rgba(0,0,0,0) ${surface}%)`;
  const cardOpacity = interp(shut ?? frame, [B.fadeOutStart, B.fadeOutEnd], [1, 0]);
  const glowPulse = 0.5 - 0.5 * Math.cos((frame / 40) * Math.PI);
  const btnLeft = 184;
  const btnTop = 52.896;
  const btnImages = (
    <>
      <img
        src={asset('power-off.svg')}
        alt=""
        style={{position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 1 - powerOn, translate: '-1px 5px'}}
      />
      <img
        src={asset('power-on.svg')}
        alt=""
        style={{position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: powerOn, translate: '-1px 6px'}}
      />
    </>
  );

  return (
    <div style={{position: 'absolute', left, top, width: 524, height: 648, zIndex: 3}}>
      <div style={{position: 'absolute', inset: 0, borderRadius: 40, boxShadow: CARD_SHADOW, overflow: 'hidden'}}>
        <img
          src={asset('vpr-off.png')}
          alt=""
          style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover'}}
        />
        <img
          src={asset('vpr-card.png')}
          alt=""
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: cardOpacity,
            WebkitMaskImage: mask,
            maskImage: mask,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: btnLeft - 43.68,
            top: btnTop - 43.68,
            width: 243.36,
            height: 243.36,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(16,185,129,0.85) 0%, rgba(16,185,129,0) 66%)',
            opacity: powerOn * (0.14 + 0.2 * glowPulse),
            filter: 'blur(9px)',
            pointerEvents: 'none',
          }}
        />
      </div>
      <div
        style={{
          position: 'absolute',
          left: btnLeft,
          top: btnTop,
          width: 156,
          height: 156,
          transform: `scale(${press})`,
          transformOrigin: 'center center',
        }}>
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            onPointerEnter={() => setHover(true)}
            onPointerLeave={() => setHover(false)}
            aria-label={powerOn > 0.5 ? 'Turn the AI VPN demo off' : 'Turn the AI VPN demo on'}
            aria-pressed={powerOn > 0.5}
            style={{
              position: 'absolute',
              inset: 0,
              padding: 0,
              border: 0,
              borderRadius: '50%',
              background: 'transparent',
              cursor: 'pointer',
              pointerEvents: 'auto',
              transform: `scale(${hover ? 1.04 : 1})`,
              transition: 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}>
            {btnImages}
          </button>
        ) : (
          btnImages
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Connector lines with flow pulses (`at` / `an` / `ai`)
   ============================================================ */
const UPPER_PATH = 'M1 6 H85';
const LOWER_PATH = 'M 10 0 L 10 79';
const SAVING_PATH = 'M1 6 H99';

function UpperConnector() {
  const frame = useFrame();
  const flows = [
    {start: B.reqUpStart, end: B.reqUpEnd, reverse: false},
    {start: B.respUpStart, end: B.respUpEnd, reverse: true},
    {start: B.webReqUpStart, end: B.webReqUpEnd, reverse: false},
    {start: B.webRespUpStart, end: B.webRespUpEnd, reverse: true},
    {start: B.endFlowStart, end: B.endFlowEnd, reverse: false},
  ];
  const grow = growth(frame, B.chatLineGrowStart, B.chatLineGrowEnd);
  const out = useOut();
  if (grow <= 0 || out <= 0) return null;
  const dash = `${84 * grow} 84`;
  const offset = -(84 * (1 - grow));
  const active = activeFlow(frame, flows);
  return (
    <svg width={172} height={24} viewBox="0 0 86 12" style={{position: 'absolute', left: 594, top: 364, overflow: 'visible', opacity: out}}>
      <defs>
        <filter id="cl2-glow-tight" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="1.5" />
        </filter>
        <filter id="cl2-flow" x="-300%" y="-300%" width="700%" height="700%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>
      <path d={UPPER_PATH} fill="none" stroke="#059669" strokeWidth={1.5} strokeLinecap="round" strokeDasharray={dash} strokeDashoffset={offset} opacity={0.55} />
      <path d={UPPER_PATH} fill="none" stroke="#A7F3D0" strokeWidth={2.5} strokeLinecap="round" strokeDasharray={dash} strokeDashoffset={offset} opacity={0.7} filter="url(#cl2-glow-tight)" />
      {grow >= 1 && active && (
        <>
          <path d={UPPER_PATH} fill="none" stroke="#ECFDF5" strokeWidth={7} strokeLinecap="round" strokeDasharray="24 84" strokeDashoffset={dashOffset(active.t, 24, 84, active.f.reverse)} opacity={0.28 * pulseFade(active.t)} filter="url(#cl2-flow)" />
          <path d={UPPER_PATH} fill="none" stroke="#FFFFFF" strokeWidth={2.5} strokeLinecap="round" strokeDasharray="12 84" strokeDashoffset={dashOffset(active.t, 12, 84, active.f.reverse)} opacity={0.7 * pulseFade(active.t)} filter="url(#cl2-glow-tight)" />
        </>
      )}
    </svg>
  );
}

function LowerConnector() {
  const frame = useFrame();
  const flows = [
    {start: B.reqDownStart, end: B.reqDownEnd, reverse: false},
    {start: B.respDownStart, end: B.respDownEnd, reverse: true},
    {start: B.endFlowStart, end: B.endFlowEnd, reverse: true},
  ];
  const grow = growth(frame, B.lowerLineGrowStart, B.lowerLineGrowEnd);
  const out = useOut();
  if (grow <= 0 || out <= 0) return null;
  const dash = `${79 * grow} 79`;
  const active = activeFlow(frame, flows);
  return (
    <svg width={40} height={158} viewBox="0 0 20 79" style={{position: 'absolute', left: 1004, top: 756, overflow: 'visible', opacity: out}}>
      <defs>
        <filter id="vcl2-glow-tight" x="-10" y="-10" width="40" height={99} filterUnits="userSpaceOnUse">
          <feGaussianBlur stdDeviation="2" />
        </filter>
        <filter id="vcl2-flow" x="-25" y="-15" width="70" height={109} filterUnits="userSpaceOnUse">
          <feGaussianBlur stdDeviation="3.5" />
        </filter>
      </defs>
      <path d={LOWER_PATH} fill="none" stroke="#059669" strokeWidth={1.5} strokeLinecap="round" strokeDasharray={dash} strokeDashoffset={0} opacity={0.55} />
      <path d={LOWER_PATH} fill="none" stroke="#A7F3D0" strokeWidth={3} strokeLinecap="round" strokeDasharray={dash} strokeDashoffset={0} opacity={0.75} filter="url(#vcl2-glow-tight)" />
      {grow >= 1 && active && (
        <>
          <path d={LOWER_PATH} fill="none" stroke="#ECFDF5" strokeWidth={9} strokeLinecap="round" strokeDasharray="22 79" strokeDashoffset={dashOffset(active.t, 22, 79, active.f.reverse)} opacity={0.3 * pulseFade(active.t)} filter="url(#vcl2-flow)" />
          <path d={LOWER_PATH} fill="none" stroke="#FFFFFF" strokeWidth={3} strokeLinecap="round" strokeDasharray="11 79" strokeDashoffset={dashOffset(active.t, 11, 79, active.f.reverse)} opacity={0.75 * pulseFade(active.t)} filter="url(#vcl2-glow-tight)" />
        </>
      )}
    </svg>
  );
}

function SavingConnector() {
  const frame = useFrame();
  const flows = [
    {start: B.savingFlowStart, end: B.savingFlowEnd, reverse: false},
    {start: B.endFlowStart, end: B.endFlowEnd, reverse: true},
  ];
  const grow = growth(frame, B.savingLineGrowStart, B.savingLineGrowEnd);
  const out = useOut();
  if (grow <= 0 || out <= 0) return null;
  const dash = `${98 * grow} 98`;
  const active = activeFlow(frame, flows);
  return (
    <svg width={200} height={24} viewBox="0 0 100 12" style={{position: 'absolute', left: 1286, top: 364, overflow: 'visible', opacity: out}}>
      <defs>
        <filter id="sc2-glow-tight" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="1.5" />
        </filter>
        <filter id="sc2-flow" x="-300%" y="-300%" width="700%" height="700%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>
      <path d={SAVING_PATH} fill="none" stroke="#059669" strokeWidth={1.5} strokeLinecap="round" strokeDasharray={dash} strokeDashoffset={0} opacity={0.55} />
      <path d={SAVING_PATH} fill="none" stroke="#A7F3D0" strokeWidth={2.5} strokeLinecap="round" strokeDasharray={dash} strokeDashoffset={0} opacity={0.7} filter="url(#sc2-glow-tight)" />
      {grow >= 1 && active && (
        <>
          <path d={SAVING_PATH} fill="none" stroke="#ECFDF5" strokeWidth={7} strokeLinecap="round" strokeDasharray="26 98" strokeDashoffset={dashOffset(active.t, 26, 98, active.f.reverse)} opacity={0.28 * pulseFade(active.t)} filter="url(#sc2-flow)" />
          <path d={SAVING_PATH} fill="none" stroke="#FFFFFF" strokeWidth={2.5} strokeLinecap="round" strokeDasharray="13 98" strokeDashoffset={dashOffset(active.t, 13, 98, active.f.reverse)} opacity={0.7 * pulseFade(active.t)} filter="url(#sc2-glow-tight)" />
        </>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------
   Mobile stack connector — the same ink as the desktop lines, but drawn
   straight in scene units so the column can space its links freely.
   (The desktop connectors render a fixed viewBox at 2x; here the stroke
   widths are already doubled, which lands on the same on-screen weight.)
   ------------------------------------------------------------------ */
function StackConnector({
  id,
  x,
  top,
  len,
  grow: growBeats,
  flows,
}: {
  /** unique filter id — SVG filter ids are document-global */
  id: string;
  /** scene x the line runs down */
  x: number;
  top: number;
  len: number;
  grow: {start: number; end: number};
  flows: Flow[];
}) {
  const frame = useFrame();
  const grow = growth(frame, growBeats.start, growBeats.end);
  const out = useOut();
  if (grow <= 0 || out <= 0) return null;
  const d = `M 20 0 L 20 ${len}`;
  const dash = `${len * grow} ${len}`;
  const active = activeFlow(frame, flows);
  return (
    <svg
      width={40}
      height={len}
      viewBox={`0 0 40 ${len}`}
      style={{position: 'absolute', left: x - 20, top, overflow: 'visible', opacity: out}}>
      <defs>
        <filter id={`${id}-tight`} x={-20} y={-20} width={80} height={len + 40} filterUnits="userSpaceOnUse">
          <feGaussianBlur stdDeviation={4} />
        </filter>
        <filter id={`${id}-flow`} x={-50} y={-30} width={140} height={len + 60} filterUnits="userSpaceOnUse">
          <feGaussianBlur stdDeviation={7} />
        </filter>
      </defs>
      <path d={d} fill="none" stroke="#059669" strokeWidth={3} strokeLinecap="round" strokeDasharray={dash} opacity={0.55} />
      <path d={d} fill="none" stroke="#A7F3D0" strokeWidth={6} strokeLinecap="round" strokeDasharray={dash} opacity={0.75} filter={`url(#${id}-tight)`} />
      {grow >= 1 && active && (
        <>
          <path d={d} fill="none" stroke="#ECFDF5" strokeWidth={18} strokeLinecap="round" strokeDasharray={`44 ${len}`} strokeDashoffset={dashOffset(active.t, 44, len, active.f.reverse)} opacity={0.3 * pulseFade(active.t)} filter={`url(#${id}-flow)`} />
          <path d={d} fill="none" stroke="#FFFFFF" strokeWidth={6} strokeLinecap="round" strokeDasharray={`22 ${len}`} strokeDashoffset={dashOffset(active.t, 22, len, active.f.reverse)} opacity={0.75 * pulseFade(active.t)} filter={`url(#${id}-tight)`} />
        </>
      )}
    </svg>
  );
}

/* ============================================================
   Antseed network searching bar (`al`)
   ============================================================ */
function NetworkBar({
  opacity = 1,
  scale = 1,
  left = 946,
  top = 914,
}: {
  opacity?: number;
  scale?: number;
  left?: number;
  top?: number;
}) {
  const frame = useFrame();
  const angle = Math.atan2(-20.67, 18.33) + (frame * Math.PI * 2) / 50;
  const dotX = 47.67 + 27.6 * Math.cos(angle);
  const dotY = 45.67 + 27.6 * Math.sin(angle);
  return (
    <div style={{position: 'absolute', left, top, width: 852, height: 192, opacity, transform: `scale(${scale})`}}>
      <img
        src={asset('antseed-searching.svg')}
        alt=""
        style={{position: 'absolute', inset: 0, width: '100%', height: '100%'}}
      />
      <svg viewBox="0 0 426 96" style={{position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible'}}>
        <defs>
          <filter id="sc-dot-glow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle cx={dotX} cy={dotY} r={3} fill="#38E1A9" filter="url(#sc-dot-glow)" />
      </svg>
    </div>
  );
}

/* ============================================================
   Tokens-saving card with live counter (`af` + `ac`)
   ============================================================ */
function SavingCounter({p}: {p: number}) {
  const tokens = Math.round(1204 * p);
  const cost = (0.36 * p).toFixed(2);
  const official = (0.81 * p).toFixed(2);
  const saving = Math.round(56 * p);
  return (
    <div
      style={{
        position: 'absolute',
        left: 64,
        top: 40,
        width: 450,
        height: 128,
        borderRadius: 16,
        backgroundColor: '#FFFFFF',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 8,
        padding: '0 24px',
      }}>
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12}}>
        <span style={{fontSize: 24, fontFamily: DEMO_FONT, fontWeight: 400, color: '#001E12', whiteSpace: 'nowrap'}}>
          {tokens.toLocaleString('en-US')} Tokens · ${cost}
        </span>
        <span style={{fontSize: 24, fontFamily: DEMO_FONT, fontWeight: 400, color: '#001E12', textDecoration: 'line-through', whiteSpace: 'nowrap'}}>
          Official ${official}
        </span>
      </div>
      <div style={{display: 'flex', justifyContent: 'flex-end'}}>
        <span style={{fontSize: 32, fontFamily: DEMO_FONT, fontWeight: 600, color: '#008359', letterSpacing: '-0.3px'}}>
          Saving {saving}%
        </span>
      </div>
    </div>
  );
}

function TokensSaving({
  opacity = 1,
  scale = 1,
  left = 1224,
  top = 414,
}: {
  opacity?: number;
  scale?: number;
  left?: number;
  top?: number;
}) {
  const frame = useFrame();
  const p = interp(frame, [B.tokensCountStart, B.tokensCountEnd], [0, 1], easeOutExp);
  return (
    <div style={{position: 'absolute', left, top, width: 578, height: 256, opacity, transform: `scale(${scale})`, zIndex: 6}}>
      <img
        src={asset('tokens-saving.svg')}
        alt=""
        style={{position: 'absolute', left: 0, top: 0, width: 578, height: 256, display: 'block'}}
      />
      <SavingCounter p={p} />
    </div>
  );
}

/* ============================================================
   Routing bar + model roulette (`ay` + `ag`)
   ============================================================ */
const ROULETTE_MODELS = ['Grok 4.5', 'Kimi K3', 'Gemini 3.1 Pro', 'Grok 4.5', 'GPT-5.5'];
const ROULETTE_EXTRA = ['Gemini 3.1 Pro', 'Grok 4.5', 'GPT-5.5'];

function ModelRoulette({
  secondModel,
  switchStart,
  switchEnd,
}: {
  secondModel?: string;
  switchStart?: number;
  switchEnd?: number;
}) {
  const frame = useFrame();
  const extra = secondModel ? [...ROULETTE_EXTRA, secondModel] : [];
  const all = [...ROULETTE_MODELS, ...extra];
  let pos =
    interp(frame, [B.rouletteStart, B.rouletteEnd], [0, 1], easeOutCubic) *
    (ROULETTE_MODELS.length - 1);
  if (secondModel && switchStart != null && switchEnd != null) {
    pos += interp(frame, [switchStart, switchEnd], [0, 1], easeOutCubic) * extra.length;
  }
  const shift = -(56 * pos);
  return (
    <>
      <div style={{position: 'absolute', left: 508, top: 92, width: 224, height: 56, overflow: 'hidden', backgroundColor: '#FFFFFF'}}>
        <div style={{position: 'absolute', left: 0, top: 0, width: '100%', transform: `translateY(${shift}px)`}}>
          {all.map((model, i) => (
            <div key={i} style={{height: 56, display: 'flex', alignItems: 'center'}}>
              <span style={{fontFamily: DEMO_FONT, fontSize: 28, lineHeight: '40px', fontWeight: 500, color: '#001E12', whiteSpace: 'nowrap'}}>
                {model}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div style={{position: 'absolute', left: 740, top: 92, height: 56, display: 'flex', alignItems: 'center', backgroundColor: '#FFFFFF'}}>
        <ChevronDownIcon size={28} color="#001E12" strokeWidth={1.8} />
      </div>
    </>
  );
}

function RoutingBar({appName = 'Any Agentic Desktop App'}: {appName?: string}) {
  return (
    <div style={{position: 'absolute', left: 0, top: 0, width: 860, height: 252}}>
      <img src={asset('routing-model-bar.svg')} alt="" style={{width: 860, height: 252, display: 'block'}} />
      <div style={{position: 'absolute', left: 112, top: 98, width: 664, height: 44, backgroundColor: '#FFFFFF'}} />
      <div style={{position: 'absolute', left: 128, top: 98, width: 648, height: 44, display: 'flex', alignItems: 'center'}}>
        <span style={{fontSize: 28, fontFamily: DEMO_FONT, fontWeight: 500, color: '#001E12', whiteSpace: 'nowrap'}}>
          {appName}
        </span>
      </div>
    </div>
  );
}

/* ============================================================
   Pop-in wrapper (`ax`)
   ============================================================ */
function Pop({
  start,
  dur = 10,
  fromY = 0,
  style,
  transformOrigin = 'center center',
  children,
}: {
  start: number;
  dur?: number;
  fromY?: number;
  style?: CSSProperties;
  transformOrigin?: string;
  children: ReactNode;
}) {
  const frame = useFrame();
  const {opacity, scale, t} = popIn(frame, start, dur);
  const out = useOut();
  return (
    <div
      style={{
        position: 'absolute',
        opacity: opacity * out,
        transform: `translateY(${fromY * (1 - t)}px) scale(${scale})`,
        transformOrigin,
        ...style,
      }}>
      {children}
    </div>
  );
}

/* ============================================================
   Mobile scene — the stacked column, 660×924
   ============================================================ */
function MobileScene({onToggle}: {onToggle?: () => void}) {
  const frame = useFrame();
  const out = useOut();
  const routing = popIn(frame, B.modelRevealStart, B.modelRevealEnd - B.modelRevealStart);
  const tokens = popIn(frame, B.tokensRevealStart);
  const network = popIn(frame, B.networkRevealStart);

  return (
    <div style={{position: 'absolute', inset: 0}}>
      {/* 1 — the AI VPN itself: 524 wide, centred, the anchor of the column */}
      <VprCard left={M_CX - 262} top={0} onToggle={onToggle} />

      {/* 2 — routing + model roulette, sized to cover the card's baked-in
             routing row (467×80 centred at 262,249 in card space) and to
             overhang the card on both sides the way the desktop pill does */}
      <div
        style={{
          position: 'absolute',
          left: -100,
          top: 142,
          width: 860,
          height: 252,
          opacity: routing.opacity * out,
          transform: `scale(${M_ROUTING_S * routing.scale})`,
          transformOrigin: 'center center',
          zIndex: 5,
        }}>
        <RoutingBar appName="Any Agentic App" />
        <ModelRoulette />
      </div>

      {/* 3 — the price, hung straight off the model row and right-aligned to
             the pill's edge: the receipt for the model that was just picked,
             so adjacency does the linking and no connector is needed.
             ink 312..433, right edge on the pill's 620 */}
      <TokensSaving
        left={122}
        top={267}
        opacity={tokens.opacity * out}
        scale={M_TOKENS_S * tokens.scale}
      />

      {/* 4 — AI VPN -> network, with the anonymous relay sitting on the line.
             The node stays small enough that the wire still reads either
             side of it — it is a stop on the line, not a break in it. */}
      <StackConnector
        id="m-net"
        x={M_CX}
        top={656}
        len={100}
        grow={{start: B.lowerLineGrowStart, end: B.lowerLineGrowEnd}}
        flows={[
          {start: B.reqDownStart, end: B.reqDownEnd, reverse: false},
          {start: B.respDownStart, end: B.respDownEnd, reverse: true},
          {start: B.endFlowStart, end: B.endFlowEnd, reverse: true},
        ]}
      />
      <Pop
        start={B.anonNodeStart}
        dur={B.anonNodeEnd - B.anonNodeStart}
        style={{left: M_CX - 32, top: 674, width: 64, height: 64, zIndex: 6}}>
        <img src={asset('anonymous-node.svg')} alt="" style={{width: 64, height: 64, display: 'block'}} />
      </Pop>

      {/* 5 — the network: widest layer, frames the whole column, ink 764..884 */}
      <NetworkBar
        left={-96}
        top={731}
        opacity={network.opacity * out}
        scale={M_NETWORK_S * network.scale}
      />
    </div>
  );
}

/* ============================================================
   Scene (`aE`) — 2048×1152
   ============================================================ */
function Scene({mobile, onToggle}: {mobile?: boolean; onToggle?: () => void}) {
  const frame = useFrame();
  const out = useOut();

  if (mobile) return <MobileScene onToggle={onToggle} />;

  const network = popIn(frame, B.networkRevealStart);
  const tokens = popIn(frame, B.tokensRevealStart);
  const chat = popIn(frame, B.chatRevealStart, B.chatRevealEnd - B.chatRevealStart);
  const chatFade = interp(frame, [B.chatFadeStart, B.chatFadeEnd], [1, 0]);
  const chatOpacity = chat.opacity * chatFade * out;
  const web = popIn(frame, B.webRevealStart, B.webRevealEnd - B.webRevealStart);
  const webOpacity = web.opacity * out;

  return (
    <div style={{position: 'absolute', inset: 0}}>
      <div style={{position: 'absolute', left: 0, top: 0, width: 2048, height: 1152, backgroundColor: 'transparent'}}>
        <VprCard left={762} onToggle={onToggle} />
        <UpperConnector />
        <LowerConnector />
        <SavingConnector />
        {chatOpacity > 0 && (
          <div
            style={{
              position: 'absolute',
              left: 54,
              top: 148,
              width: 540,
              height: 660,
              opacity: chatOpacity,
              transform: `scale(${chat.scale})`,
              transformOrigin: 'left top',
              zIndex: 2,
            }}>
            <ChatApp style={{left: 0, top: 0, width: 540, height: 660}} />
          </div>
        )}
        {webOpacity > 0 && (
          <div
            style={{
              position: 'absolute',
              left: 54,
              top: 148,
              width: 540,
              height: 660,
              opacity: webOpacity,
              transform: `scale(${web.scale})`,
              transformOrigin: 'left top',
              zIndex: 2,
            }}>
            <ChatApp web style={{left: 0, top: 0, width: 540, height: 660}} />
          </div>
        )}
      </div>
      <Pop
        start={B.modelRevealStart}
        dur={B.modelRevealEnd - B.modelRevealStart}
        style={{left: 594, top: 274, width: 860, height: 252, zIndex: 5}}>
        <RoutingBar appName="Any Agentic App" />
        <ModelRoulette secondModel="Kimi K3" switchStart={B.webRevealStart} switchEnd={B.webTypingStart} />
      </Pop>
      <TokensSaving left={1412} top={272} opacity={tokens.opacity * out} scale={tokens.scale} />
      <Pop
        start={B.pricePopStart}
        dur={B.pricePopEnd - B.pricePopStart}
        fromY={12}
        style={{left: 1472, top: 450, width: 518, height: 216, zIndex: 10}}>
        <img src={asset('price-popup.svg')} alt="" style={{width: 518, height: 216, display: 'block', translate: '1px -31px'}} />
      </Pop>
      <Pop
        start={B.anonNodeStart}
        dur={B.anonNodeEnd - B.anonNodeStart}
        style={{left: 988, top: 780, width: 72, height: 72, zIndex: 6}}>
        <img src={asset('anonymous-node.svg')} alt="" style={{width: 72, height: 72, display: 'block', translate: '0px 28px'}} />
      </Pop>
      <NetworkBar left={598} top={914} opacity={network.opacity * out} scale={network.scale} />
      <Pop
        start={B.anonPopStart}
        dur={B.anonPopEnd - B.anonPopStart}
        fromY={12}
        style={{left: 158, top: 937, width: 512, height: 216, zIndex: 10}}>
        <img src={asset('anonymous-popup.svg')} alt="" style={{width: 512, height: 216, display: 'block', translate: '-21px -14px'}} />
      </Pop>
      <Pop
        start={B.favoritePopStart}
        dur={B.favoritePopEnd - B.favoritePopStart}
        fromY={12}
        style={{left: 298, top: 75, width: 570, height: 216, zIndex: 10}}>
        <img src={asset('favorite-popup.svg')} alt="" style={{width: 570, height: 216, display: 'block', translate: '-64.8px -10px'}} />
      </Pop>
    </div>
  );
}

/* ============================================================
   Player — rAF clock, scales the 2048×1152 scene to fit
   ============================================================ */
const SHUTDOWN_FRAMES = B.fadeOutEnd - B.fadeOutStart;

/**
 * Mobile runs the same scene on a shorter clock. The chat beats are gone from
 * the stacked composition, so the stretches that only served them (54→190 and
 * 380→542) have nothing to show. The loop plays three segments of scene frames
 * back to back instead — same curves, same components, ~11.6s instead of 19.4s.
 * Segment one is identity-mapped, which keeps the power button's restart
 * (`origin = now - powerOnStart`) correct on both layouts.
 */
const MOBILE_SEGMENTS: [number, number][] = [
  [0, 60], // off hold -> power on -> card surface reveal
  [185, 386], // routing + roulette -> price -> network -> response
  [494, 582], // closing pulse -> hold -> fade out
];
const MOBILE_TOTAL_FRAMES = MOBILE_SEGMENTS.reduce((n, [a, b]) => n + (b - a), 0);

/** timeline frame (0..MOBILE_TOTAL_FRAMES) -> scene frame */
function mobileSceneFrame(t: number) {
  let rest = t;
  for (const [a, b] of MOBILE_SEGMENTS) {
    if (rest < b - a) return a + rest;
    rest -= b - a;
  }
  return B.total;
}

/** running = the loop plays; shuttingDown = the manual off beat; off = parked. */
type PowerMode = 'running' | 'shuttingDown' | 'off';

export function HeroDemo({
  frameRef,
  shutdownRef,
  className,
  compact = false,
}: {
  /** Shared frame counter (read by the hero dot canvas each rAF). */
  frameRef?: MutableRefObject<number>;
  /**
   * Shared manual-shutdown clock: 0 while the loop runs, otherwise a virtual
   * frame in [fadeOutStart, fadeOutEnd] the dot canvas dissolves the ant with.
   */
  shutdownRef?: MutableRefObject<number>;
  className?: string;
  /** Force the stacked single-column scene regardless of viewport width
      (used when the demo shares the hero row with the copy). */
  compact?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(0);
  const [shut, setShut] = useState<number | null>(null);
  const [interactive, setInteractive] = useState(false);
  const [scale, setScale] = useState(0.5);
  const [mobileMq, setMobileMq] = useState(false);
  const mobile = compact || mobileMq;
  const modeRef = useRef<PowerMode>('running');
  const originRef = useRef(0); // clock origin (ms) — frame 0 of the loop
  const frozenRef = useRef(0); // scene frame held during shutdown
  const shutStartRef = useRef(0);

  /**
   * Power button. While the AI VPN reads as on, a click plays the loop's closing
   * beat over the frozen frame and parks the demo off; otherwise it restarts
   * the loop at the button press so the whole opening replays.
   */
  const toggle = useCallback(() => {
    if (modeRef.current === 'shuttingDown') return;
    const f = frozenRef.current;
    if (modeRef.current === 'running' && f >= B.powerOnStart && f < B.fadeOutStart) {
      shutStartRef.current = performance.now();
      modeRef.current = 'shuttingDown';
      return;
    }
    // off, or inside the loop's own off window: light it up and carry on.
    originRef.current = performance.now() - (B.powerOnStart / DEMO_FPS) * 1000;
    modeRef.current = 'running';
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const update = () => setMobileMq(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const sceneW = mobile ? M_W : 2048;
  const sceneH = mobile ? M_H : 1152;

  // read inside the rAF loop, which must not re-subscribe on a breakpoint flip
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const resize = new ResizeObserver(() => {
      setScale(host.clientWidth / sceneW);
    });
    resize.observe(host);
    setScale(host.clientWidth / sceneW);
    return () => resize.disconnect();
  }, [sceneW]);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Rest on a fully-revealed frame instead of animating.
      const restFrame = B.holdEnd - 1;
      setFrame(restFrame);
      if (frameRef) frameRef.current = restFrame;
      return undefined;
    }
    setInteractive(true);
    let raf = 0;
    originRef.current = performance.now();
    const loop = (now: number) => {
      if (modeRef.current === 'running') {
        const total = mobileRef.current ? MOBILE_TOTAL_FRAMES : DEMO_TOTAL_FRAMES;
        const t = (((now - originRef.current) / 1000) * DEMO_FPS) % total;
        const f = mobileRef.current ? mobileSceneFrame(t) : t;
        frozenRef.current = f;
        if (frameRef) frameRef.current = f;
        if (shutdownRef) shutdownRef.current = 0;
        setFrame(f);
        setShut(null);
      } else if (modeRef.current === 'shuttingDown') {
        const elapsed = ((now - shutStartRef.current) / 1000) * DEMO_FPS;
        const sf = B.fadeOutStart + Math.min(SHUTDOWN_FRAMES, elapsed);
        if (frameRef) frameRef.current = frozenRef.current;
        if (shutdownRef) shutdownRef.current = sf;
        setFrame(frozenRef.current);
        setShut(sf);
        if (elapsed >= SHUTDOWN_FRAMES) modeRef.current = 'off';
      } else {
        // parked off: frame 0 is the loop's own off-hold state.
        frozenRef.current = 0;
        if (frameRef) frameRef.current = 0;
        if (shutdownRef) shutdownRef.current = 0;
        setFrame(0);
        setShut(null);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [frameRef, shutdownRef]);

  return (
    <div ref={hostRef} className={className} style={{aspectRatio: `${sceneW} / ${sceneH}`, position: 'relative', overflow: 'visible'}}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: sceneW,
          height: sceneH,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          fontFamily: DEMO_FONT,
          textAlign: 'left',
          // decorative scenery never eats the power button's clicks
          pointerEvents: 'none',
        }}>
        <FrameContext.Provider value={frame}>
          <ShutdownContext.Provider value={shut}>
            <Scene mobile={mobile} onToggle={interactive ? toggle : undefined} />
          </ShutdownContext.Provider>
        </FrameContext.Provider>
      </div>
    </div>
  );
}
