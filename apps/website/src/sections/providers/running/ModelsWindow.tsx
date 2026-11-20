import {useRef, type JSX} from 'react';
import clsx from 'clsx';
import {CheckIcon, Cursor, Logo, MiniButton, Stage, Window} from './Scene';
import {useTypedPrice} from './useTypedPrice';
import styles from './ModelsWindow.module.css';

type Model = {
  name: string;
  logo: string;
  /** Logos without their own background sit on a glass tile. */
  glass: boolean;
  price: string;
  checked: boolean;
};

const ICONS = '/site/assets/home/icons';
const MODELS: readonly Model[] = [
  {name: 'qwen3.8-omni-flash', logo: `${ICONS}/qwen.svg`, glass: true, price: '$0.03', checked: true},
  {name: 'deepseek-v4.1-flash', logo: `${ICONS}/deepseek.svg`, glass: false, price: '$0.02', checked: true},
  {name: 'kimi-k3', logo: `${ICONS}/kimi.svg`, glass: true, price: '$0.05', checked: false},
];
/** The row whose price is being typed. */
const EDITING = 'deepseek-v4.1-flash';

const LABEL = 'Models to serve on an RTX 5090: qwen3.8-omni-flash at $0.03 per million tokens, deepseek-v4.1-flash with its price being typed at $0.02, kimi-k3 unchecked, and the Go live button';

/** Choosing what to serve on a GPU, and at what price: the second price types in once the window is seen. */
export function ModelsWindow(): JSX.Element {
  const stage = useRef<HTMLDivElement>(null);
  const typed = useRef<HTMLElement>(null);
  const editing = MODELS.find((m) => m.name === EDITING)!;
  const blinking = useTypedPrice(stage, typed, editing.price);
  return (
    <Stage ref={stage} label={LABEL}>
      <Window className={styles.window}>
        <p className={styles.head}><b>Models to serve</b><span>RTX 5090<i className={styles.memory}> · 32 GB</i></span></p>
        {MODELS.map((m) => {
          const isEditing = m === editing;
          return (
            <div key={m.name} className={clsx(styles.row, !m.checked && styles.off)}>
              <p className={styles.model}>
                <i className={clsx(styles.box, m.checked && styles.boxOn)}>{m.checked && <CheckIcon />}</i>
                <Logo src={m.logo} glass={m.glass} className={styles.logo} />
                {m.name}
              </p>
              <p className={clsx(styles.price, isEditing && styles.priceOn)}>
                <b ref={isEditing ? typed : undefined}>{m.price}</b>
                {isEditing && <i className={clsx(styles.caret, blinking && styles.blink)} />}
                <span>/M</span>
              </p>
            </div>
          );
        })}
        <p className={styles.go}><MiniButton className={styles.goButton}>Go live</MiniButton></p>
      </Window>
      <Cursor className={styles.cursor} />
    </Stage>
  );
}
