// X (Twitter) pieces: the optional sign-in in the header, names and avatars on
// the leaderboard, and the panel under Your points that links a wallet to an X account.
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useState } from 'react';
import type { Address } from 'viem';
import { useSignMessage } from 'wagmi';
import { useWallet } from '../lib/actions';
import { avatarColor, shortAddress } from '../lib/format';
import { Link } from '../lib/router';
import { profileHref, signInHref, useLinkWallet, useMe, useProfiles, useSignOut, useUnlinkWallet, type PublicProfile } from '../lib/social';
import { LINKS } from '../lib/links';
import { openWalletLink } from '../lib/xWelcome';

export function XLogo({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function Avatar({ src, name, size = 28 }: { src?: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return <img className="xavatar" src={src} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return (
    <span className="xavatar" aria-hidden="true" style={{ width: size, height: size, background: avatarColor(name), fontSize: size * 0.42 }}>
      {name.replace(/^@/, '').slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Header: "Sign in with X", or your avatar and handle once signed in. Hidden when X isn't configured. */
export function XAccountButton() {
  const me = useMe().data;
  const signOut = useSignOut();
  const [open, setOpen] = useState(false);
  if (!me?.xEnabled) return null;
  if (!me.signedIn || !me.handle) {
    return (
      <a className="btn btn-line btn-sm x-btn" href={signInHref()} aria-label="Sign in with X">
        <XLogo />
        <span className="hide-s">Sign in</span>
      </a>
    );
  }
  const linked = Boolean(me.addresses?.length);
  // Signed in but no wallet linked yet: the header itself asks for it, so a skipped step is never lost.
  if (!linked) {
    return (
      <button type="button" className="x-me x-link" onClick={openWalletLink} title={`Signed in as @${me.handle}`}>
        <Avatar src={me.avatar} name={me.handle} size={30} />
        <span>Link wallet</span>
      </button>
    );
  }
  return (
    <div className="x-menu" onMouseLeave={() => setOpen(false)}>
      <button type="button" className="x-me" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Avatar src={me.avatar} name={me.handle} size={30} />
        <span className="hide-s">@{me.handle}</span>
      </button>
      {open && (
        <div className="x-menu-list" role="menu">
          <Link role="menuitem" href={profileHref(me.handle)} onClick={() => setOpen(false)}>Your profile</Link>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); openWalletLink(); }}>Link another wallet</button>
          <a role="menuitem" href={LINKS.followX} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>Follow @antseed</a>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); signOut.mutate(); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}

/** A wallet cell: the linked X name when there is one, the short address otherwise. */
export function Who({ address, profile }: { address: string; profile?: PublicProfile }) {
  if (!profile) return <span className="num">{shortAddress(address)}</span>;
  return (
    <Link className="who-x" href={profileHref(profile.handle)}>
      <Avatar src={profile.avatar} name={profile.handle} />
      <span className="who-x-text">
        <b>{profile.name || `@${profile.handle}`}</b>
        <span>@{profile.handle}</span>
      </span>
    </Link>
  );
}

/**
 * Under Your points: show who this wallet is linked to, or let the signed-in X
 * account claim it by signing with the wallet or its reward wallet.
 */
export function LinkXPanel({ address, operator }: { address: Address; operator: Address | null }) {
  const meQ = useMe();
  const me = meQ.data;
  const profiles = useProfiles([address]);
  const linked = profiles.data?.[address.toLowerCase()];
  const wallet = useWallet();
  const { signMessageAsync } = useSignMessage();
  const linkM = useLinkWallet();
  const unlinkM = useUnlinkWallet();
  const signOut = useSignOut();

  if (!me?.xEnabled && !linked) return null;

  const mine = Boolean(me?.signedIn && me.addresses?.includes(address.toLowerCase()));
  // Some wallets are their own reward wallet; only mention a second wallet when there is one.
  const op = operator && operator.toLowerCase() !== address.toLowerCase() ? operator.toLowerCase() : undefined;
  const canSign = Boolean(wallet.address && (wallet.address === address.toLowerCase() || wallet.address === op));
  const error = (linkM.error || unlinkM.error) as Error | null;
  const friendly = error && /reject|denied|cancel/i.test(error.message) ? 'The signature was cancelled.' : error?.message;

  return (
    <div className="panel xlink">
      <div className="xlink-who">
        {linked ? (
          <>
            <Avatar src={linked.avatar} name={linked.handle} size={52} />
            <div className="stack" style={{ gap: 2 }}>
              <span className="eyebrow">On the leaderboard as</span>
              <Link href={profileHref(linked.handle)} className="xlink-name">
                {linked.name || `@${linked.handle}`} <span className="muted">@{linked.handle}</span>
              </Link>
            </div>
          </>
        ) : (
          <>
            <span className="xlink-mark"><XLogo size={22} /></span>
            <div className="stack" style={{ gap: 4 }}>
              <b style={{ fontSize: 17 }}>Put your X name on the leaderboard</b>
              <span className="muted" style={{ fontSize: 14 }}>
                Optional. Your points stay on Base either way; linking only shows your name and a profile page you can share.
              </span>
            </div>
          </>
        )}
      </div>

      <div className="xlink-act">
        {!me?.signedIn ? (
          me?.xEnabled ? (
            <a className="btn btn-ink btn-sm" href={signInHref()}>
              <XLogo /> Sign in with X
            </a>
          ) : null
        ) : mine ? (
          <>
            <Link className="btn btn-line btn-sm" href={profileHref(me.handle!)}>Your profile</Link>
            <button type="button" className="btn btn-line btn-sm" disabled={unlinkM.isPending} onClick={() => unlinkM.mutate(address)}>Unlink</button>
          </>
        ) : canSign ? (
          <button
            type="button"
            className="btn btn-ink btn-sm"
            disabled={linkM.isPending}
            onClick={() => linkM.mutate({ me, address, sign: (message) => signMessageAsync({ message, account: wallet.address }) })}
          >
            {linkM.isPending ? 'Check your wallet…' : `${linked ? 'Move' : 'Link'} to @${me.handle}`}
          </button>
        ) : (
          <ConnectButton.Custom>
            {({ account, openConnectModal, openAccountModal }) => (
              <button type="button" className="btn btn-ink btn-sm" onClick={account ? openAccountModal : openConnectModal}>
                {account ? `Switch to ${shortAddress(op ?? address)} to link` : op ? 'Connect your reward wallet to link' : 'Connect this wallet to link'}
              </button>
            )}
          </ConnectButton.Custom>
        )}
        {me?.signedIn && (
          <>
            <a className="linkish" href={LINKS.followX} target="_blank" rel="noopener noreferrer">Follow @antseed</a>
            <button type="button" className="linkish" onClick={() => signOut.mutate()}>
              Signed in as @{me.handle} · sign out
            </button>
          </>
        )}
      </div>

      {me?.signedIn && !mine && (
        <p className="note" style={{ margin: 0, gridColumn: '1 / -1' }}>
          Your X profile will be publicly linked to this address and its points.{' '}
          {op
            ? `Sign a free message with this address or its reward wallet (${shortAddress(op)}), the wallet that claims its ANTS. No transaction, no gas.`
            : 'Sign a free message with this wallet to prove it’s yours. No transaction, no gas.'}
          {linked && !mine ? ` It's linked to @${linked.handle} right now; signing moves it to you.` : ''}
        </p>
      )}
      {friendly && <div className="notice bad" style={{ gridColumn: '1 / -1' }}>{friendly}</div>}
    </div>
  );
}
