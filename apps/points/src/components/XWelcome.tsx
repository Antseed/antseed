import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useSignMessage } from 'wagmi';
import { useWallet } from '../lib/actions';
import { useViewedAddress } from '../lib/address';
import { isAddress, shortAddress } from '../lib/format';
import { LINKS } from '../lib/links';
import { useAccount, type Network } from '../lib/model';
import { useLinkWallet, useMe } from '../lib/social';
import { onOpenWalletLink } from '../lib/xWelcome';
import { XLogo } from './Social';

const KEY = 'antseed-points.x-welcome-done';
const isDone = (id: string) => {
  try {
    return (localStorage.getItem(KEY) ?? '').split(',').includes(id);
  } catch {
    return false;
  }
};
const markDone = (id: string) => {
  try {
    const all = new Set((localStorage.getItem(KEY) ?? '').split(',').filter(Boolean));
    all.add(id);
    localStorage.setItem(KEY, [...all].join(','));
  } catch {
    /* private window: the flow just shows again next time */
  }
};

/**
 * Right after X sign-in, one guided flow: you're signed in → link your Antseed account (a free
 * signature from the account or its reward wallet, so a name can't be attached to someone else's
 * points) → follow @antseed. Each step can be skipped; it shows once per X account.
 */
export function XWelcome({ net }: { net: Network | undefined }) {
  const me = useMe().data;
  const id = me?.signedIn ? me.xId ?? me.handle ?? null : null;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'link' | 'follow'>('link');
  // 'welcome' right after sign-in (all three steps); 'link' when reopened only to link a wallet.
  const [mode, setMode] = useState<'welcome' | 'link'>('welcome');
  useEffect(() => {
    if (!id || isDone(id)) return setOpen(false);
    setOpen(true);
    setMode('welcome');
    setStep(me?.addresses?.length ? 'follow' : 'link');
    // Open once per sign-in; later changes to `me` (like a new link) must not reset the step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // Reopened on purpose (header menu, Your points): straight to connecting a wallet, done flag or not.
  useEffect(() => onOpenWalletLink(() => { setMode('link'); setStep('link'); setOpen(true); }), []);
  if (!open || !id || !me) return null;
  const close = () => {
    markDone(id);
    setOpen(false);
  };


  return (
    <div className="xw-scrim" role="presentation">
      <div className="xw" role="dialog" aria-modal="true" aria-labelledby="xw-h">
        <button type="button" className="xw-x" aria-label="Close" onClick={close}>×</button>
        <h2 id="xw-h" className="disp">{mode === 'link' ? 'Link a wallet' : `You're in, @${me.handle}`}</h2>
        {mode === 'welcome' && <ol className="xw-steps">
          <li data-state="done"><span /><b>Signed in with X</b></li>
          <li data-state={step === 'link' ? 'now' : 'done'}><span /><b>Connect your wallet</b></li>
          <li data-state={step === 'follow' ? 'now' : 'todo'}><span /><b>Follow @antseed</b></li>
        </ol>}
        {step === 'link' ? <LinkStep net={net} onDone={() => (mode === 'link' ? close() : setStep('follow'))} /> : <FollowStep onDone={close} />}
      </div>
    </div>
  );
}

function LinkStep({ net, onDone }: { net: Network | undefined; onDone: () => void }) {
  const me = useMe().data!;
  const { address: viewed, setAddress } = useViewedAddress();
  const wallet = useWallet();
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState(viewed ?? '');
  // The account looked up on the page: if the connected wallet is its reward wallet, link that account.
  const viewedAcct = useAccount(viewed ?? null, net);
  const viewedOperator = viewedAcct.data?.operator?.toLowerCase() ?? null;
  const typed = isAddress(value) ? (value.toLowerCase() as Address) : null;
  const typedAcct = useAccount(custom ? typed : null, net);
  const typedOperator = typedAcct.data?.operator?.toLowerCase() ?? null;

  // Which account this signature links: a typed one, else the looked-up account it's the reward wallet of, else the wallet itself.
  const account: Address | null = custom
    ? typed
    : wallet.address
      ? (viewed && viewedOperator === wallet.address ? viewed : wallet.address)
      : null;
  const operator = custom ? typedOperator : account === viewed ? viewedOperator : null;
  const canSign = Boolean(wallet.address && account && (wallet.address === account || wallet.address === operator));
  const { signMessageAsync } = useSignMessage();
  const link = useLinkWallet();
  const error = link.error as Error | null;

  const submit = () => {
    if (!account || !canSign || !wallet.address) return;
    link.mutate(
      { me, address: account, sign: (message) => signMessageAsync({ message, account: wallet.address! }) },
      { onSuccess: () => { setAddress(account); onDone(); } },
    );
  };

  return (
    <div className="xw-body">
      <p>Connect the wallet you use with Antseed, or its reward wallet, and sign once. It's free: no transaction, no gas. Your X profile will be publicly linked to this address and its points.</p>
      {custom && (
        <>
          <label className="xw-field">
            <span>Antseed account address</span>
            <input value={value} onChange={(e) => setValue(e.target.value.trim())} placeholder="0x…" spellCheck={false} autoComplete="off" aria-invalid={Boolean(value) && !typed} />
          </label>
          {value && !typed && <span className="lookup-error">Enter a valid address beginning with 0x.</span>}
        </>
      )}
      {wallet.address && account && (
        <span className="xw-note">
          {canSign
            ? <>Linking <b>{shortAddress(account)}</b>{account !== wallet.address ? <>, signed by its reward wallet {shortAddress(wallet.address)}</> : null}.</>
            : <>{shortAddress(wallet.address)} can't sign for {shortAddress(account)}. Connect that account{operator && operator !== account ? <> or its reward wallet {shortAddress(operator as Address)}</> : null}.</>}
        </span>
      )}
      <div className="xw-act">
        {wallet.address && canSign ? (
          <button type="button" className="btn btn-ink" disabled={link.isPending} onClick={submit}>{link.isPending ? 'Check your wallet…' : 'Sign to link'}</button>
        ) : (
          <ConnectButton.Custom>
            {({ account: acc, openConnectModal, openAccountModal }) => (
              <button type="button" className="btn btn-ink" onClick={acc ? openAccountModal : openConnectModal}>
                {acc ? 'Switch wallet' : 'Connect wallet'}
              </button>
            )}
          </ConnectButton.Custom>
        )}
        <button type="button" className="linkish" onClick={onDone}>Skip for now</button>
      </div>
      {!custom && (
        <button type="button" className="linkish xw-alt" onClick={() => setCustom(true)}>Link a different account</button>
      )}
      {error && <span className="lookup-error">{/reject|denied|cancel/i.test(error.message) ? 'The signature was cancelled.' : error.message}</span>}
    </div>
  );
}

function FollowStep({ onDone }: { onDone: () => void }) {
  return (
    <div className="xw-body">
      <p>Follow @antseed for weekly rewards and new providers.</p>
      <div className="xw-act">
        <a className="btn btn-ink" href={LINKS.followX} target="_blank" rel="noopener noreferrer" onClick={onDone}><XLogo /> Follow @antseed</a>
        <button type="button" className="linkish" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}
