import type {JSX} from 'react';
import {Actions, Button, Wash} from '../../components';
import type {ColonyPath} from './paths';
import {COMMUNITY_URL, SIGN_UP_HREF} from './signUpLinks';
import styles from './Colonies.module.css';

/** One way into a Colony: its painting, its name with its state in grey, a paragraph and its buttons. */
export default function ColonyPathCard({path}: {path: ColonyPath}): JSX.Element {
  return (
    <article id={path.id} className={styles.card}>
      <Wash unveil className={styles.painting} day={path.painting.day} night={path.painting.night} label={path.painting.label} />
      <h3 className={styles.name}>{path.name}<br className={styles.nameBreak} /> <span className={styles.state}>{path.state}</span></h3>
      <p className={styles.copy}>{path.copy}</p>
      <Actions fill className={styles.actions}>
        {path.action === 'signUp' ? (
          <>
            <Button href={SIGN_UP_HREF} size="page">Sign up for early access</Button>
            {COMMUNITY_URL && <Button href={COMMUNITY_URL} variant="ghost" size="page">Join the Mac Colony community</Button>}
          </>
        ) : (
          <Button disabled size="page">{path.state}</Button>
        )}
      </Actions>
    </article>
  );
}
