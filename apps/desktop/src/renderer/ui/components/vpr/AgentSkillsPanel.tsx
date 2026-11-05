import { useEffect, useState } from 'react';
import type { AgentSkillTarget } from '../../../types/bridge';
import { AppPillIcon, appPillStyles as pills } from './AppPills';
import styles from './AgentSkillsPanel.module.scss';

/**
 * "Use it with your agent": adds Antseed's skills to an agent the user
 * already runs, so it keeps its own model and calls Antseed when asked.
 * Shown on Home and on the Apps page.
 */
export function AgentSkillsPanel({ className }: { className?: string }) {
  const [agents, setAgents] = useState<AgentSkillTarget[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

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
        setNote({ text: `Added to ${agent.label}. Start a new session and ask, for example, “using Antseed, generate an image of…”`, error: false });
      }
    } finally {
      setBusy(null);
    }
  }

  async function copySetup(): Promise<void> {
    const result = await window.antseedDesktop?.agentSkillsCopyPrompt?.();
    setNote(result?.ok
      ? { text: 'Copied. Paste it into your agent; it includes your gateway URL and API key.', error: false }
      : { text: result?.error ?? 'Could not copy', error: true });
  }

  // Agents found on this computer first; the rest can still take the skills.
  const shown = [...agents].sort((left, right) => Number(right.detected) - Number(left.detected));

  return (
    <div className={`${styles.panel}${className ? ` ${className}` : ''}`}>
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
        <p className={note.error ? `${styles.note} ${styles.noteError}` : styles.note} role={note.error ? 'alert' : 'status'}>
          {note.text}
        </p>
      )}
    </div>
  );
}
