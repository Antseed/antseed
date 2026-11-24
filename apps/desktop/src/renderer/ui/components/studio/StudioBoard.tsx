import { useState } from 'react';
import { Badge, Button } from '@antseed/ui';
import type { StudioProjectDetail, StudioShot } from '../../../../shared/studio.js';
import {
  boardProgress,
  formatStudioUsd,
  shotBadge,
  shotMedia,
  studioFileUrl,
  studioMimeType,
  studioMoney,
  totalSeconds,
} from '../../../modules/studio/board-view';
import { AttachmentViewer, type ViewerAttachment } from '../chat/AttachmentViewer';
import styles from './StudioBoard.module.scss';

export function StudioBoard({ detail }: { detail: StudioProjectDetail }) {
  const { board, files, project } = detail;
  const [viewing, setViewing] = useState<ViewerAttachment | null>(null);
  const open = (filePath: string, name: string) => {
    setViewing({ name, mimeType: studioMimeType(filePath), src: studioFileUrl(project.id, filePath, files[filePath]), noDownload: true });
  };
  const final = board.final !== null && files[board.final] !== undefined ? board.final : null;
  const seconds = totalSeconds(board);
  const facts = [boardProgress(board), seconds > 0 ? `${String(seconds)} s` : null, board.aspectRatio || null].filter(Boolean).join(' · ');

  return (
    <div className={styles.board}>
      {detail.boardError ? (
        <p className={styles.notice} role="status"><span className={styles.dot} aria-hidden="true" />{detail.boardError}. Ask the agent to write it again.</p>
      ) : null}

      {board.shots.length === 0 ? (
        <div className={styles.empty}>
          <h2 className={styles.emptyTitle}>The storyboard appears here</h2>
          <ol className={styles.steps}>
            <li>Tell the agent what you want to make.</li>
            <li>It plans the shots and prices the whole piece before anything is paid for.</li>
            <li>It makes one still picture per shot. You fix them one at a time.</li>
            <li>Only then is the video made and joined.</li>
          </ol>
        </div>
      ) : (
        <>
          <div className={styles.summary}>
            <p className={styles.facts}>{facts}</p>
            {board.brief ? <p className={styles.brief}>{board.brief}</p> : null}
          </div>

          <StudioPrice detail={detail} />

          {final ? (
            <section className={styles.final}>
              <h2 className={styles.heading}>Final video</h2>
              <video className={styles.finalVideo} src={studioFileUrl(project.id, final, files[final])} controls playsInline preload="metadata" />
            </section>
          ) : null}

          <section>
            <h2 className={styles.heading}>{board.kind === 'pictures' ? 'Pictures' : 'Shots'}</h2>
            <ol className={styles.grid}>
              {board.shots.map((shot) => (
                <ShotTile key={shot.id} shot={shot} projectId={project.id} files={files} aspectRatio={board.aspectRatio} onOpen={open} />
              ))}
            </ol>
          </section>
        </>
      )}

      <p className={styles.folder}>
        <span className={styles.folderPath} title={detail.folder}>{detail.folder}</span>
        <Button variant="link" className={styles.openFolder} onClick={() => { void window.antseedDesktop?.studioOpenFolder?.(project.id); }}>Open folder</Button>
      </p>

      {viewing ? <AttachmentViewer attachment={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

function tileRatio(aspectRatio: string): string {
  const match = /^(\d{1,3})\s*:\s*(\d{1,3})$/.exec(aspectRatio);
  return match && Number(match[1]) > 0 && Number(match[2]) > 0 ? `${match[1]} / ${match[2]}` : '16 / 9';
}

function ShotTile({ shot, projectId, files, aspectRatio, onOpen }: {
  shot: StudioShot;
  projectId: string;
  files: Record<string, number>;
  aspectRatio: string;
  onOpen: (filePath: string, name: string) => void;
}) {
  const media = shotMedia(shot, files);
  const badge = shotBadge(shot.status);
  const name = `Shot ${shot.id}${shot.title ? `: ${shot.title}` : ''}`;
  return (
    <li className={styles.tile}>
      <div className={styles.frame} style={{ aspectRatio: tileRatio(aspectRatio) }}>
        {media?.kind === 'video' ? (
          <video
            className={styles.media}
            src={studioFileUrl(projectId, media.path, media.version)}
            {...(media.poster ? { poster: studioFileUrl(projectId, media.poster.path, media.poster.version) } : {})}
            controls
            playsInline
            preload="metadata"
            aria-label={name}
          />
        ) : media ? (
          <button type="button" className={styles.mediaButton} onClick={() => onOpen(media.path, name)} title="Open full size">
            <img className={styles.media} src={studioFileUrl(projectId, media.path, media.version)} alt={name} loading="lazy" />
          </button>
        ) : (
          <span className={styles.placeholder}>{shot.status === 'planned' ? 'No still yet' : 'File not found'}</span>
        )}
      </div>
      <div className={styles.tileHead}>
        <span className={styles.shotId}>{shot.id}</span>
        <span className={styles.shotTitle} title={shot.title}>{shot.title || 'Untitled shot'}</span>
        {shot.durationSeconds !== null ? <span className={styles.duration}>{String(shot.durationSeconds)} s</span> : null}
      </div>
      {shot.description ? <p className={styles.description}>{shot.description}</p> : null}
      <div className={styles.tileFoot}>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {shot.note ? <span className={styles.note} title={shot.note}>{shot.note}</span> : null}
      </div>
    </li>
  );
}

function StudioPrice({ detail }: { detail: StudioProjectDetail }) {
  const { board } = detail;
  const money = studioMoney(board);
  if (money.estimateUsd === null && board.spent.length === 0) return null;
  return (
    <section className={styles.price}>
      <div className={styles.priceTotals}>
        {money.estimateUsd !== null ? (
          <div className={styles.priceTotal}>
            <span className={styles.priceLabel}>{money.approved ? 'Agreed price for the whole piece' : 'Estimated price for the whole piece'}</span>
            <span className={styles.priceValue}>{money.approved ? '' : 'about '}{formatStudioUsd(money.estimateUsd)}</span>
          </div>
        ) : null}
        <div className={styles.priceTotal}>
          <span className={styles.priceLabel}>Spent so far, by the agent&apos;s count</span>
          <span className={styles.priceValue}>{formatStudioUsd(money.spentUsd)}</span>
        </div>
      </div>
      {money.over ? (
        <p className={styles.notice} role="status"><span className={`${styles.dot} ${styles.dotWarning}`} aria-hidden="true" />More has been spent than the price shown here.</p>
      ) : money.estimateUsd !== null && !money.approved ? (
        <p className={styles.priceHint}>Nothing beyond the amount spent is paid for until you tell the agent to go.</p>
      ) : null}
      {board.estimate && board.estimate.lines.length > 0 ? (
        <table className={styles.lines}>
          <tbody>
            {board.estimate.lines.map((line, index) => (
              <tr key={`${line.label}:${String(index)}`}>
                <th scope="row">{line.label}</th>
                <td className={styles.lineDetail}>{line.detail}</td>
                <td className={styles.lineUsd}>{formatStudioUsd(line.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
