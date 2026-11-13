import { useCallback, useEffect, useState } from 'react';
import type { AgentSkillsResult, AgentSkillTarget } from '../../types/bridge';

/**
 * The agents Antseed's skills can be added to, and adding or removing them.
 * Each caller keeps its own copy and its own feedback: `update` returns the
 * result (or throws) and only refreshes the list from it.
 */
export function useAgentSkills(): {
  targets: AgentSkillTarget[];
  busy: string | null;
  update: (id: string, action: 'install' | 'remove') => Promise<AgentSkillsResult | undefined>;
} {
  const [targets, setTargets] = useState<AgentSkillTarget[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.antseedDesktop?.agentSkillsList?.()
      .then((list) => { if (!cancelled) setTargets(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const update = useCallback(async (id: string, action: 'install' | 'remove') => {
    setBusy(id);
    try {
      const bridge = window.antseedDesktop;
      const result = action === 'install' ? await bridge?.agentSkillsInstall?.(id) : await bridge?.agentSkillsRemove?.(id);
      if (result?.targets) setTargets(result.targets);
      return result;
    } finally {
      setBusy(null);
    }
  }, []);

  return { targets, busy, update };
}
