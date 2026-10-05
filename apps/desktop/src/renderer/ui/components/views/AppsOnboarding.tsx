import { Button } from '@antseed/ui';
import { BrandIcon } from '../brand/BrandIcon';
import styles from './AppsOnboarding.module.scss';

/* First-visit coach mark for the Apps screen: one tooltip pointing at the
   app list, with a hard-coded looping mini-demo inside — a tiny app window
   (Claude, then Cursor) playing a chat that routes through the AI VPN. All
   data is hard-coded so brand-new users see a full demo. */
export function AppsOnboarding({ onDone }: { onDone: () => void }): JSX.Element {
  return (
    <div className={styles.layer} aria-live="polite">
      <div className={styles.tip} role="dialog" aria-label="Connect the tools you already use">
        <div className={styles.tipInner}>
          <span className={styles.arrow} aria-hidden="true" />
          <p className={styles.tipTitle}>Connect the tools you already use</p>

          {/* Mini demo window: 12s loop = the same 6s chat playing once as
              Claude and once as Cursor (header identities crossfade). */}
          <div className={styles.demo} aria-hidden="true">
            <div className={styles.demoHeader}>
              <span className={styles.demoDots}>
                <span /><span /><span />
              </span>
              <span className={`${styles.demoApp} ${styles.demoAppFirst}`}>
                <BrandIcon brand="anthropic" size={13} />
                Claude
              </span>
              <span className={`${styles.demoApp} ${styles.demoAppSecond}`}>
                <BrandIcon brand="cursor" size={13} />
                Cursor
              </span>
            </div>
            <div className={styles.demoBody}>
              <span className={styles.demoUser}>Explain this error</span>
              <span className={styles.demoTyping}>
                <span /><span /><span />
              </span>
              <span className={styles.demoAnswer}>
                `user` is undefined here — add a guard before the call.
                <span className={styles.demoVia}>via your AI VPN</span>
              </span>
            </div>
          </div>

          <p className={styles.tipBody}>
            Flip an app on and its AI chats route through your AI VPN — same
            models, one balance.
          </p>
          <div className={styles.tipFoot}>
            <Button variant="primary" size="sm" fullWidth onClick={onDone}>
              Got it
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
