import { useCallback, useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpRight01Icon, Copy01Icon, Settings02Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { Modal } from '@antseed/ui';
import type { TelegramBridgeStatus } from '../../../types/bridge';
import { BrandIcon } from '../brand/BrandIcon';
import styles from './VprToolsView.module.scss';
import { recordUserAction } from '../../../modules/telemetry/actions';

/**
 * "Telegram Bot" row in Connected apps. Unlike proxy-profile apps this does
 * not intercept anything — it pairs the user's personal Telegram bot with
 * the local chat agent (main-process bridge long-polls the Bot API).
 */
export function TelegramBotCard() {
  const [status, setStatus] = useState<TelegramBridgeStatus | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [connectBusy, setConnectBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [changingBot, setChangingBot] = useState(false);

  useEffect(() => {
    const bridge = window.antseedDesktop;
    let disposed = false;
    void bridge?.telegramGetStatus?.().then((result) => {
      if (!disposed && result.ok && result.data) setStatus(result.data);
    });
    const off = bridge?.onTelegramStatusChanged?.((next) => setStatus(next));
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  const connect = useCallback(async () => {
    const bridge = window.antseedDesktop;
    const token = tokenDraft.trim();
    if (!token || !bridge?.telegramConnect) return;
    recordUserAction('app_connect', 'apps', 'telegram');
    setConnectBusy(true);
    setError(null);
    try {
      const result = await bridge.telegramConnect(token);
      if (result.data) setStatus(result.data);
      if (!result.ok) {
        setError(result.error ?? 'Unable to connect the bot');
        return;
      }
      setTokenDraft('');
      setChangingBot(false);
    } finally {
      setConnectBusy(false);
    }
  }, [tokenDraft]);

  const disconnect = useCallback(async () => {
    const bridge = window.antseedDesktop;
    if (!bridge?.telegramDisconnect) return;
    if (!window.confirm('Disconnect the Telegram bot? The saved token is removed from this device.')) return;
    recordUserAction('app_disconnect', 'apps', 'telegram');
    const result = await bridge.telegramDisconnect();
    if (result.data) setStatus(result.data);
    setChangingBot(false);
  }, []);

  const openPairingLink = useCallback(() => {
    if (status?.pairingLink) void window.antseedDesktop?.openExternalUrl?.(status.pairingLink);
  }, [status?.pairingLink]);

  const copyPairingLink = useCallback(() => {
    if (!status?.pairingLink) return;
    void navigator.clipboard.writeText(status.pairingLink).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    });
  }, [status?.pairingLink]);

  const configured = status?.configured ?? false;
  const paired = status?.paired ?? false;
  const showTokenForm = !configured || changingBot;

  const meta = !configured
    ? null
    : !paired
      ? 'Waiting for pairing in Telegram'
      : `@${status?.botUsername ?? ''}`;

  return (
    <>
      <div className={`${styles.appPill}${paired ? ` ${styles.appPillConnected}` : ''}`}>
        <div className={styles.appHead}>
          <span className={styles.appIdentity}>
            <BrandIcon name="telegram" hints={['Telegram']} size={24} />
            <span className={styles.appText}>
              <span className={styles.appNameRow}>
                <span className={styles.appName}>Telegram Bot</span>
                {paired ? (
                  <span className={styles.appMeta}>
                    <span className={styles.connectedDot} aria-hidden="true" />
                    Connected
                  </span>
                ) : null}
              </span>
              {meta ? <span className={styles.appMeta}>{meta}</span> : null}
            </span>
          </span>
          {configured ? (
            <button
              type="button"
              className={`${styles.configAction}${modalOpen ? ` ${styles.configActionActive}` : ''}`}
              onClick={() => setModalOpen(true)}
              aria-haspopup="dialog"
              aria-label="Telegram Bot settings"
              title="Telegram Bot settings"
            >
              <HugeiconsIcon icon={Settings02Icon} size={15} strokeWidth={2} />
            </button>
          ) : (
            <button
              type="button"
              className={styles.connectAction}
              onClick={() => setModalOpen(true)}
            >
              Connect
            </button>
          )}
        </div>
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => { setModalOpen(false); setError(null); setChangingBot(false); }}
        size="sm"
        title="Telegram Bot"
        subtitle={(
          <span className={styles.modalAppSubtitle}>
            Connect a private Telegram bot to chat with your Antseed agent from Telegram.
            <button
              type="button"
              className={styles.settingWebsiteLink}
              onClick={() => void window.antseedDesktop?.openExternalUrl?.('https://telegram.org/apps')}
            >
              Website / download
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
            </button>
          </span>
        )}
        bodyClassName={styles.settingsBody}
      >
        {showTokenForm ? (
          <>
            <section className={styles.settingSection}>
              <div className={styles.settingHead}>
                <span className={styles.settingTitle}>1. Create a bot</span>
              </div>
              <p className={styles.settingHint}>
                In Telegram, message{' '}
                <button
                  type="button"
                  className={styles.settingHintLink}
                  onClick={() => void window.antseedDesktop?.openExternalUrl?.('https://t.me/BotFather')}
                  title="Open @BotFather in Telegram"
                >
                  <code>@BotFather</code>
                </button>
                , send <code>/newbot</code> and
                pick a name. BotFather replies with a token like <code>123456:ABC-…</code>.
              </p>
            </section>
            <section className={styles.settingSection}>
              <div className={styles.settingHead}>
                <span className={styles.settingTitle}>2. Paste the token</span>
              </div>
              <div className={styles.settingInputRow}>
                <input
                  type="password"
                  className={styles.settingInput}
                  value={tokenDraft}
                  placeholder="Bot token"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setTokenDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void connect(); }}
                />
              </div>
              <p className={styles.settingHint}>
                The token is stored encrypted on this device and never leaves it —
                the bot talks to Telegram directly from this computer.
              </p>
              {error ? <p className={styles.note} role="alert">{error}</p> : null}
            </section>
            <div className={styles.settingFooter}>
              {changingBot ? (
                <button
                  type="button"
                  className={styles.settingDanger}
                  onClick={() => { setChangingBot(false); setError(null); }}
                >
                  Cancel
                </button>
              ) : null}
              <button
                type="button"
                className={styles.connectAction}
                disabled={connectBusy || tokenDraft.trim().length === 0}
                onClick={() => void connect()}
              >
                {connectBusy ? 'Connecting…' : 'Connect bot'}
              </button>
            </div>
          </>
        ) : !paired ? (
          <>
            <section className={styles.settingSection}>
              <div className={styles.settingHead}>
                <span className={styles.settingTitle}>Pair with @{status?.botUsername}</span>
              </div>
              <p className={styles.settingHint}>
                Open the link below in Telegram and press <strong>Start</strong>. The first
                chat that presents this link becomes the bot&apos;s owner — the bridge
                answers no one else.
              </p>
              <div className={styles.settingActions}>
                <button type="button" className={styles.connectAction} onClick={openPairingLink}>
                  Open in Telegram
                  <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  className={styles.configAction}
                  onClick={copyPairingLink}
                  aria-label="Copy pairing link"
                  title="Copy pairing link"
                >
                  <HugeiconsIcon icon={linkCopied ? Tick02Icon : Copy01Icon} size={15} strokeWidth={2} />
                </button>
              </div>
              {status?.lastError ? <p className={styles.note} role="alert">{status.lastError}</p> : null}
            </section>
            <div className={styles.settingFooter}>
              <button type="button" className={styles.settingDanger} onClick={() => void disconnect()}>
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <>
            <section className={styles.settingSection}>
              <div className={styles.settingHead}>
                <span className={styles.settingTitle}>@{status?.botUsername}</span>
                <span className={styles.settingConnected}>
                  <span className={styles.connectedDot} aria-hidden="true" />
                  Connected
                </span>
              </div>
              <p className={styles.settingHint}>
                Paired with {status?.ownerName ?? 'you'} on Telegram. Messages to the bot
                run on this computer&apos;s agent and are billed like any AI VPN chat.
                Use <code>/new</code> for a fresh conversation and <code>/stop</code> to
                cancel a reply. Risky tool calls ask for approval with buttons in the chat.
              </p>
              {status?.lastError ? <p className={styles.note} role="alert">{status.lastError}</p> : null}
            </section>
            <div className={styles.settingFooter}>
              <button
                type="button"
                className={styles.settingDanger}
                onClick={() => { setChangingBot(true); setError(null); }}
              >
                Change bot
              </button>
              <button type="button" className={styles.settingDanger} onClick={() => void disconnect()}>
                Disconnect
              </button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
