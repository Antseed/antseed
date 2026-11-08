import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpRight01Icon, Copy01Icon } from '@hugeicons/core-free-icons';
import type { AgentSkillTarget } from '../../../types/bridge';
import { AppPillIcon, appPillStyles as pills } from './AppPills';
import styles from './AgentSkillsPanel.module.scss';

/**
 * "Use it with your agent": adds Antseed's skills to an agent the user
 * already runs, so it keeps its own model and calls Antseed when asked.
 * Shown on Home and on Agents & apps.
 */
export function AgentSkillsPanel({ className, page = false }: {
  className?: string;
  /** On the Agents & apps page its section gives the heading; the setup prompt is the card's main action. */
  page?: boolean;
}) {
  const [agents, setAgents] = useState<AgentSkillTarget[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean; open?: AgentSkillTarget } | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.antseedDesktop?.agentSkillsList?.()
      .then((targets) => { if (!cancelled) setAgents(targets); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function toggle(agent: AgentSkillTarget): Promise<void> {
    if (busy) return;
    setBusy(agent.id);
    setNote(null);
    try {
      const bridge = window.antseedDesktop;
      const result = agent.installed
        ? await bridge?.agentSkillsRemove?.(agent.id)
        : await bridge?.agentSkillsInstall?.(agent.id);
      if (result?.targets) setAgents(result.targets);
      if (!result?.ok) {
        setNote({ text: result?.error ?? 'Could not update the skills', error: true });
      } else if (!agent.installed) {
        const canOpen = agent.detected && Boolean(bridge?.agentSkillsOpen);
        setNote({
          // Short enough to share one line with the Open button.
          text: canOpen
            ? `Added to ${agent.label}. In a new session, try “using Antseed, generate an image of…”`
            : `Added to ${agent.label}. Start a new session and ask, for example, “using Antseed, generate an image of…”`,
          error: false,
          ...(canOpen ? { open: agent } : {}),
        });
      }
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message : 'Could not update the skills', error: true });
    } finally {
      setBusy(null);
    }
  }

  async function openAgent(agent: AgentSkillTarget): Promise<void> {
    if (opening) return;
    setOpening(true);
    try {
      const result = await window.antseedDesktop?.agentSkillsOpen?.(agent.id);
      if (!result?.ok) setNote({ text: result?.error ?? `Could not open ${agent.label}`, error: true });
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message : `Could not open ${agent.label}`, error: true });
    } finally {
      setOpening(false);
    }
  }

  async function copySetup(): Promise<void> {
    try {
      const result = await window.antseedDesktop?.agentSkillsCopyPrompt?.();
      setNote(result?.ok
        ? { text: 'Copied. Paste it into your agent; it includes your gateway URL and API key.', error: false }
        : { text: result?.error ?? 'Could not copy', error: true });
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message : 'Could not copy', error: true });
    }
  }

  // Agents found on this computer first; the rest can still take the skills.
  const shown = [...agents].sort((left, right) => Number(right.detected) - Number(left.detected));

  return (
    <div className={`${styles.panel}${className ? ` ${className}` : ''}`}>
      {page ? (
        <div className={styles.pageHeader}>
          <p className={styles.pageText}>Paste this setup prompt into any agent so it can reach Antseed through this app.</p>
          <button type="button" className={styles.copyPrompt} onClick={() => { void copySetup(); }}>
            <HugeiconsIcon icon={Copy01Icon} size={18} strokeWidth={1.7} />
            Copy setup prompt
          </button>
        </div>
      ) : (
        <>
          <div className={styles.header}>
            <p className={styles.title}>Use it with your agent</p>
            <button type="button" className={styles.link} onClick={() => { void copySetup(); }}>
              Copy for any agent
            </button>
          </div>
          <p className={styles.caption}>
            Your agent keeps its own model and calls Antseed when you ask: “using Antseed, generate an image”,
            make a video, or ask another model for a second opinion.
          </p>
        </>
      )}
      <div className={pills.pillList}>
        {shown.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={`${pills.pill}${agent.installed ? ` ${pills.pillActive}` : ''}${agent.detected ? '' : ` ${pills.pillMuted}`}`}
            disabled={busy !== null}
            aria-pressed={agent.installed}
            onClick={() => { void toggle(agent); }}
            title={agent.installed
              ? `Antseed skills are in ${agent.skillsDir}. Click to remove them.`
              : `Add the Antseed skills to ${agent.label} (${agent.skillsDir})${agent.detected ? '' : ' — not found on this computer'}`}
          >
            <AppPillIcon name={agent.id} displayName={agent.label} />
            <span className={pills.pillLabel}>
              {busy === agent.id ? (agent.installed ? 'Removing…' : 'Adding…') : agent.label}
            </span>
            {agent.installed && <span className={pills.pillDot} aria-label="Skills added" />}
          </button>
        ))}
      </div>
      {note && (
        <div className={styles.noteRow}>
          <p className={note.error ? `${styles.note} ${styles.noteError}` : styles.note} role={note.error ? 'alert' : 'status'}>
            {note.text}
          </p>
          {note.open && (
            <button
              type="button"
              className={styles.openAgent}
              disabled={opening}
              onClick={() => { if (note.open) void openAgent(note.open); }}
            >
              {opening ? 'Opening…' : `Open ${note.open.label}`}
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={1.8} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
