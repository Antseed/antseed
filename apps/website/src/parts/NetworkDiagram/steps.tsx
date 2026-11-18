import type {ComponentType, ReactNode, SVGProps} from 'react';
import Step1Drawing from './drawings/Step1Drawing';
import Step2Drawing from './drawings/Step2Drawing';
import Step3Drawing from './drawings/Step3Drawing';

/** A text's weight in the step's window: quiet until its block is lit (value → ink, label → grey), faint stays faint. */
export type Tone = 'value' | 'label' | 'faint';
export type Coin = 'usdc' | 'ants';
export type Cell = {text: string; tone: Tone; coin?: Coin};
/** A row: a label at the left and its values at the right, or a table row whose cells sit at fixed columns (% of the row). */
export type Row = {kind: 'pair'; cells: Cell[]} | {kind: 'columns'; cells: (Cell & {at: number})[]};
export type Block = {title: string; rows: Row[]};
/** A legend entry: its symbol, drawn in the drawing's own coordinates around height `y`. */
export type LegendItem = {label: string; y: number; mark: ReactNode};

export type NetworkStep = {
  name: string;
  layer: string;
  /** The lit block's bar. */
  accent: string;
  /** The step's line in the row of points under the board. */
  point: string;
  Drawing: ComponentType<SVGProps<SVGSVGElement>>;
  /** The ANTS holders act in this step; on a phone they and their tag are left out of the others. */
  holders?: boolean;
  /** One block per beat of the drawing (a beat past the last lights the last). */
  blocks: Block[];
  legend: LegendItem[];
};

const value = (text: string): Cell => ({text, tone: 'value'});
const usdc = (text: string): Cell => ({text, tone: 'value', coin: 'usdc'});
const ants = (text: string): Cell => ({text, tone: 'value', coin: 'ants'});
const kv = (label: string, ...values: (string | Cell)[]): Row => ({
  kind: 'pair',
  cells: [{text: label, tone: 'label'}, ...values.map((v) => (typeof v === 'string' ? value(v) : v))],
});
const line = (text: string): Row => ({kind: 'pair', cells: [value(text)]});
const cols = (at: readonly number[], texts: readonly string[], tone: Tone = 'value'): Row => ({
  kind: 'columns',
  cells: texts.map((text, i) => ({text, tone, at: at[i]})),
});

const LISTING = [0, 25.67, 54.33, 75.22, 93.73];
const SCORE = [0, 32.84, 50.15];
const SHARE = [0, 32.84, 65.67];
const FORMULA = [0, 21.49, 36.42, 51.34, 60.3, 70.45, 84.18];

const GREEN = '#5F8A12';
const arrow = (y: number, width = 2) => (
  <>
    <path d={`M40 ${y}H54`} stroke={GREEN} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
    <path d={`M60 ${y}L53 ${y + 3.2}V${y - 3.2}L60 ${y}Z`} fill={GREEN} />
  </>
);

export const NETWORK_STEPS: readonly NetworkStep[] = [
  {
    name: 'Discovery',
    layer: 'Mainline DHT',
    accent: '#C8F53C',
    point: 'Buyers and providers find each other peer to peer.',
    Drawing: Step1Drawing,
    blocks: [
      {title: 'Announce', rows: [kv('Topic', 'antseed:subnet:7'), kv('Sellers announced', '3'), kv('Stored in the DHT', 'addresses only')]},
      {title: 'Look up', rows: [kv('Lookup', 'BEP 5, 3 hops'), kv('Your prompt', 'never sent here')]},
      {
        title: 'Listings',
        rows: [
          cols(LISTING, ['Provider A', 'deepseek-v3', '$0.11/M', 'eu', '✓']),
          cols(LISTING, ['Provider B', 'deepseek-v3', '$0.094/M', 'us', '✓']),
          cols(LISTING, ['Provider C', 'deepseek-v3', '$0.13/M', 'eu·TEE', '✓']),
        ],
      },
      {
        title: 'Pick',
        rows: [
          kv('Your minimum trust', '60'),
          cols(SCORE, ['Provider A', '79/100', 'eligible']),
          cols(SCORE, ['Provider B', '83/100', 'selected']),
          cols(SCORE, ['Provider C', '38/100', 'below the bar'], 'label'),
          kv('Picked', 'cheapest at or above 60'),
        ],
      },
    ],
    legend: [
      {label: 'DHT node', y: 940, mark: <circle cx="50" cy="940" r="3" fill="#C8F53C" stroke={GREEN} />},
      {label: 'Lookup hop', y: 960, mark: <><path d="M40 960H60" stroke={GREEN} strokeWidth="2" strokeLinecap="round" /><circle cx="50" cy="960" r="3.5" fill={GREEN} /></>},
      {
        label: 'Provider announce',
        y: 980,
        mark: <><path d="M40 980H54" stroke="#0A1A12" strokeWidth="1.5" strokeLinecap="round" /><path d="M60 980L53 983.2V976.8L60 980Z" fill="#0A1A12" /></>,
      },
      {label: 'Direct route', y: 1000, mark: <path d="M40 1000H60" stroke={GREEN} strokeWidth="2" strokeLinecap="round" strokeDasharray="4 4" />},
    ],
  },
  {
    name: 'Payments',
    layer: 'Base',
    accent: '#0000FF',
    point: 'USDC moves directly between buyers and providers.',
    Drawing: Step2Drawing,
    blocks: [
      {title: 'Deposit', rows: [kv('From', '0x9c1…42e'), kv('To', 'AntseedDeposits'), kv('Amount', usdc('10 USDC'))]},
      {title: 'reserve()', rows: [kv('Channel', '0x7a3…f10'), kv('Locked for Provider B', usdc('1 USDC')), kv('First session cap', usdc('1 USDC'))]},
      {title: 'Sign', rows: [kv('cumulativeAmount', usdc('0.00038 USDC')), kv('Signed by you', 'after each response'), kv('Onchain per request', 'nothing')]},
      {
        title: 'settle()',
        rows: [
          kv('Called', 'after 10 min idle'),
          kv('Provider B 0x41b…c09', usdc('0.000365 USDC'), '96%'),
          kv('Protocol fee', usdc('0.000015 USDC'), '4%'),
          kv('Stays in your deposit', usdc('0.99962 USDC')),
        ],
      },
    ],
    legend: [
      {label: 'Deposit', y: 924, mark: arrow(924)},
      {label: 'Reserved for a provider', y: 944, mark: <rect x="44" y="938" width="12" height="12" rx="2" fill="#0000FF" />},
      {label: 'Settlement', y: 964, mark: <>{arrow(964)}<circle cx="42" cy="964" r="1.88" fill="white" stroke="#00008F" strokeWidth="1.25" /></>},
      {label: 'Protocol fee', y: 984, mark: arrow(984, 1.25)},
      {label: 'Signed total (offchain)', y: 1004, mark: <path d="M40 1004H60" stroke={GREEN} strokeWidth="1.5" strokeLinecap="round" strokeDasharray="5 5" />},
    ],
  },
  {
    name: 'Trust',
    layer: 'ANTS',
    accent: '#3F7D1E',
    point: 'ANTS backs providers’ reputation and makes inference liquid.',
    Drawing: Step3Drawing,
    holders: true,
    blocks: [
      {
        title: 'Position',
        rows: [kv('Position', 'lANTS'), kv('Staked', ants('50,000 ANTS')), kv('Pool', 'Provider B'), kv('Lock', '12 epochs'), kv('Power', 'from epoch 32'), kv('Early exit', 'burns 5–50%')],
      },
      {
        title: 'Epoch 31',
        rows: [
          kv('Length', 'weekly'),
          line('recognized usage = settled USDC × stake'),
          cols(SHARE.slice(1), ['stake share', 'usage share'], 'label'),
          cols(SHARE, ['Provider A', '3.0%', '2.5%']),
          cols(SHARE, ['Provider B', '5.0%', '4.0%']),
          cols(SHARE, ['Provider C', '0.2%', '0.5%']),
        ],
      },
      {
        title: 'Trust score',
        rows: [
          cols(FORMULA.slice(1), ['stake', 'usage', 'ID', 'free', '× verif', 'score'], 'faint'),
          cols(FORMULA, ['Provider A', '42/70', '17/30', '16', '0', '×1.06', '79/100']),
          cols(FORMULA, ['Provider B', '47/70', '19/30', '14', '0', '×1.04', '83/100']),
          cols(FORMULA, ['Provider C', '16/70', '10/30', '6', '+5', '×1.00', '38/100'], 'label'),
          kv('Verified services', 'up to ×1.5'),
          kv('Proven wash trader', '→ 0'),
          kv('Computed', 'on your machine'),
        ],
      },
    ],
    legend: [
      {label: 'Stake', y: 944, mark: arrow(944)},
      {label: 'Pool', y: 964, mark: <rect x="41" y="959" width="18" height="10" fill="#3F7D1E" />},
      {label: 'Recognized usage', y: 984, mark: <rect x="44.5" y="978.5" width="11" height="11" fill="#C8F53C" stroke={GREEN} />},
      {label: 'Score', y: 1004, mark: <rect x="40" y="998" width="20" height="12" rx="4" fill="#C8F53C" />},
    ],
  },
];
