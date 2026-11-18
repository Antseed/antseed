import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, EmptyState, LoadingRows, Modal, TextField } from '@antseed/ui';
import { HugeiconsIcon } from '@hugeicons/react';
import { Film01Icon } from '@hugeicons/core-free-icons';
import type { StudioProjectSummary } from '../../../../shared/studio.js';
import { formatRelativeTime } from '../../../core/format';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { studioFileUrl } from '../../../modules/studio/board-view';
import { studioProjectResource, studioProjectsResource } from '../../../modules/studio/resources';
import { useActions } from '../../hooks/useActions';
import { useUiSelector } from '../../hooks/useUiSelector';
import { useRetainedState } from '../../hooks/useRetainedState';
import type { ViewName } from '../../types';
import { StudioBoard } from '../studio/StudioBoard';
import { DirectorDesk } from '../studio/DirectorDesk';
import { VprPage } from '../vpr/VprKit';
import { ChatView } from './ChatView';
import styles from './StudioView.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

const studioViewCache: { openProjectId: string | null } = { openProjectId: null };

const AGENT_HINT = 'Tell the agent what you want to make. It plans the shots and shows the price of the whole piece before anything is paid for.';

export function StudioView({ onSelectView }: Props) {
  const [openProjectId, setOpenProjectId] = useRetainedState(studioViewCache, 'openProjectId');
  return (
    <section className="view view-studio view-pinned-header" role="tabpanel">
      {openProjectId ? (
        <StudioProject key={openProjectId} id={openProjectId} onClose={() => setOpenProjectId(null)} onSelectView={onSelectView} />
      ) : (
        <StudioProjects onOpen={setOpenProjectId} />
      )}
    </section>
  );
}

function StudioProjects({ onOpen }: { onOpen: (id: string) => void }) {
  const projects = useCachedResource(studioProjectsResource);
  const [creating, setCreating] = useState(false);
  const list = projects.data;

  return (
    <VprPage
      title="Studio"
      root
      subtitle="Make videos and pictures with an agent. It plans the shots, prices the whole piece, and shows you a still of every shot before any video is paid for."
      action={<Button variant="brand" onClick={() => setCreating(true)}>New project</Button>}
    >
      <div className={styles.column}>
        {list === null ? (
          projects.error
            ? <p className={styles.notice} role="status"><span className={styles.dot} aria-hidden="true" />{projects.error}</p>
            : <LoadingRows rows={3} height={56} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<HugeiconsIcon icon={Film01Icon} size={20} strokeWidth={1.6} />}
            title="No projects yet"
            body="A project keeps the idea, the stills, the clips and the final video together, in one folder on this computer."
          />
        ) : (
          <ul className={styles.projects}>
            {list.map((project) => <ProjectCard key={project.id} project={project} onOpen={onOpen} />)}
          </ul>
        )}
      </div>
      {creating ? (
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void studioProjectsResource.reload();
            onOpen(id);
          }}
        />
      ) : null}
    </VprPage>
  );
}

function ProjectCard({ project, onOpen }: { project: StudioProjectSummary; onOpen: (id: string) => void }) {
  const shots = project.shotCount === 0 ? 'No shots yet' : `${String(project.shotCount)} shot${project.shotCount === 1 ? '' : 's'}`;
  return (
    <li>
      <button type="button" className={styles.project} onClick={() => onOpen(project.id)}>
        <span className={styles.cover}>
          {project.cover ? (
            <img src={studioFileUrl(project.id, project.cover.path, project.cover.version)} alt="" loading="lazy" />
          ) : (
            <HugeiconsIcon icon={Film01Icon} size={22} strokeWidth={1.5} />
          )}
        </span>
        <span className={styles.projectName} title={project.name}>{project.name}</span>
        <span className={styles.projectMeta}>{shots} · {formatRelativeTime(project.updatedAt)}</span>
      </button>
    </li>
  );
}

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.antseedDesktop?.studioCreate?.(name);
      if (result?.ok && result.data) onCreated(result.data.id);
      else setError(result?.error ?? 'Could not create the project');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={busy ? () => {} : onClose} title="New project" size="sm">
      <form className={styles.form} onSubmit={(event) => { void submit(event); }}>
        <TextField
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Lighthouse in a storm"
          hint="You can describe the idea to the agent next."
          error={error}
          maxLength={120}
          autoFocus
        />
        <div className={styles.formActions}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function StudioProject({ id, onClose, onSelectView }: { id: string; onClose: () => void; onSelectView?: (view: ViewName) => void }) {
  const actions = useActions();
  const resource = useMemo(() => studioProjectResource(id), [id]);
  const project = useCachedResource(resource);
  const [chatReady, setChatReady] = useState(false);
  const sending = useUiSelector(state => state.chatSending || state.chatInputDisabled || !state.chatSelectedModelId);
  const hasOpenChat = useUiSelector((state) => state.chatActiveConversation !== null);
  const splitRef = useRef<HTMLDivElement>(null);
  const onShow = (): boolean => !splitRef.current?.closest('[aria-hidden="true"]');

  useEffect(() => {
    if (!onShow()) return undefined;
    let current = true;
    void actions.openStudioProject(id).finally(() => {
      if (current) setChatReady(true);
    });
    return () => {
      current = false;
      actions.leaveStudioProject();
    };
  }, [actions, id]);

  useEffect(() => {
    if (chatReady && !hasOpenChat && onShow()) void actions.openStudioProject(id);
  }, [actions, chatReady, hasOpenChat, id]);

  const detail = project.data;
  return (
    <VprPage title={detail?.project.name ?? 'Studio'} onBack={onClose} fill>
      <div className={styles.split} ref={splitRef}>
        <div className={styles.boardPane} data-view-scroll>
          {detail ? (
            <><DirectorDesk detail={detail} canSend={chatReady && !sending} onDirect={text=>actions.sendMessage(text)}/><StudioBoard detail={detail} /></>
          ) : project.error ? (
            <p className={`${styles.notice} ${styles.paneNotice}`} role="status"><span className={styles.dot} aria-hidden="true" />{project.error}</p>
          ) : (
            <div className={styles.paneNotice}><LoadingRows rows={4} height={40} /></div>
          )}
        </div>
        <aside className={styles.chatPane} aria-label="Project agent">
          {chatReady && detail ? <ChatView embedded emptyHint={AGENT_HINT} onSelectView={onSelectView} /> : null}
        </aside>
      </div>
    </VprPage>
  );
}
