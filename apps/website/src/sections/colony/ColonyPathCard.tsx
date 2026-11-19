import type {JSX} from 'react';
import {Actions, Button, Wash} from '../../components';
import type {ColonyPath} from './paths';
import {TELEGRAM_URL} from './config';
import {useJoinHref} from './useColony';
import styles from './Colonies.module.css';

/** One way into a Colony: its painting, its name with its state in grey, a paragraph and its buttons. */
export default function ColonyPathCard({path}: {path: ColonyPath}): JSX.Element {
  const join = useJoinHref();
  const signUp = path.action === 'signUp';
  return (
    <article id={path.id} className={styles.card}>
      <Wash unveil className={styles.painting} day={path.painting.day} night={path.painting.night} label={path.painting.label} />
      <h3 className={styles.name}>{path.name}<br className={styles.nameBreak} /> <span className={styles.state}>{path.state}</span></h3>
      <p className={styles.copy}>{path.copy}</p>
      <Actions fill className={styles.actions}>
        {signUp ? (
          <>
            <Button href={join} size="page">Join the waitlist</Button>
            {TELEGRAM_URL && <Button href={TELEGRAM_URL} variant="ghost" size="page">Join Local AI Colony on Telegram</Button>}
          </>
        ) : (
          <Button disabled size="page">{path.state}</Button>
        )}
      </Actions>
    </article>
  );
}
