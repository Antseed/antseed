import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './AttachmentViewer.module.scss';

/**
 * Attachment that can be previewed. Three shapes coexist so the same modal
 * works in every call site:
 *
 * 1. Composer chips pre-send — carry a full `data:` URL in `dataUrl`.
 * 2. Chat image blocks — carry the base64 body in `imageBase64` +
 *    `imageMimeType`.
 * 3. Chat file blocks with disk-backed storage — carry a
 *    `antseed-attachment://` URL in `src`, and the renderer dispatches
 *    to the right engine based on `mimeType`.
 */
export type ViewerAttachment = {
  name: string;
  mimeType: string;
  size?: number;
  /** Full data URL (e.g. "data:image/png;base64,...") — composer chips. */
  dataUrl?: string;
  /** Image base64 body (no "data:" prefix) — image blocks. */
  imageBase64?: string;
  imageMimeType?: string;
  /**
   * Custom-protocol URL that Chromium can fetch directly (via Electron's
   * `antseed-attachment://` handler). Used by persisted file blocks so
   * PDFs, HTML, SVG and images render natively without round-tripping
   * megabytes through IPC.
   */
  src?: string;
  /**
   * When present, the Download button uses an IPC → `dialog.showSaveDialog`
   * → `copyFile` path instead of `<a download>`. More reliable than
   * relying on Chromium's save-to-disk handling of custom protocols.
   */
  downloadIpc?: { conversationId: string; attachmentId: string };
  error?: string;
};

type AttachmentViewerProps = {
  attachment: ViewerAttachment;
  onClose: () => void;
};

function formatSize(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function isImageMime(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('image/');
}

function isPdfMime(mimeType: string): boolean {
  return mimeType.toLowerCase() === 'application/pdf';
}

function isHtmlMime(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return m === 'text/html' || m === 'application/xhtml+xml';
}

/**
 * Mime types Chromium renders as plain text when asked. `text/html` is
 * handled separately (it has its own sandbox branch) so we exclude it
 * here.
 */
function isTextualMime(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  if (isHtmlMime(m)) return false;
  if (m.startsWith('text/')) return true;
  return (
    m === 'application/json'
    || m === 'application/javascript'
    || m === 'application/x-javascript'
    || m === 'application/xml'
    || m === 'application/yaml'
    || m === 'application/x-yaml'
  );
}

function buildImageSrc(att: ViewerAttachment): string | null {
  // A `src` URL (custom protocol) beats any inline bytes for images —
  // Chromium can stream the file without JS touching the bytes.
  if (att.src && isImageMime(att.mimeType)) return att.src;
  if (att.dataUrl && att.dataUrl.startsWith('data:')) return att.dataUrl;
  if (att.imageBase64 && att.imageMimeType) {
    return `data:${att.imageMimeType};base64,${att.imageBase64}`;
  }
  return null;
}

function buildDownloadHref(att: ViewerAttachment): string | null {
  // Anything reachable over the custom protocol is downloadable as-is.
  if (att.src) return att.src;
  const img = buildImageSrc(att);
  if (img) return img;
  return null;
}

export function AttachmentViewer({ attachment, onClose }: AttachmentViewerProps) {
  const [closing, setClosing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const close = useCallback(() => {
    setClosing(true);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(onClose, 180);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [close]);

  const imgSrc = useMemo(() => buildImageSrc(attachment), [attachment]);
  const pdfSrc = useMemo(
    () => (attachment.src && isPdfMime(attachment.mimeType) ? attachment.src : null),
    [attachment],
  );
  const htmlSrc = useMemo(
    () => (attachment.src && isHtmlMime(attachment.mimeType) ? attachment.src : null),
    [attachment],
  );
  const textSrc = useMemo(
    () => (attachment.src && isTextualMime(attachment.mimeType) ? attachment.src : null),
    [attachment],
  );
  const inlineHref = useMemo(() => buildDownloadHref(attachment), [attachment]);
  const hasPreview = Boolean(imgSrc || pdfSrc || htmlSrc || textSrc);

  // Reset the loading indicator when we switch to a different attachment.
  useEffect(() => {
    setLoaded(false);
  }, [imgSrc, pdfSrc, htmlSrc, textSrc]);

  const handleDownload = useCallback(async () => {
    const bridge = typeof window !== 'undefined'
      ? (window as { antseedDesktop?: { attachmentDownload?: (c: string, a: string, n: string) => Promise<{ ok: boolean; error?: string }> } }).antseedDesktop
      : undefined;
    if (attachment.downloadIpc && bridge?.attachmentDownload) {
      // Reliable path: main process streams the file through
      // dialog.showSaveDialog + fs.copyFile.
      await bridge.attachmentDownload(
        attachment.downloadIpc.conversationId,
        attachment.downloadIpc.attachmentId,
        attachment.name || 'attachment',
      );
      return;
    }
    // Fallback for composer chips (dataUrl) and chat image blocks
    // (inline base64) — these don't have a disk-backed id yet, so the
    // classic <a download> flow is fine and doesn't hit the custom
    // protocol quirk.
    if (!inlineHref) return;
    const anchor = document.createElement('a');
    anchor.href = inlineHref;
    anchor.download = attachment.name || 'attachment';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [attachment.downloadIpc, attachment.name, inlineHref]);

  const canDownload = Boolean(attachment.downloadIpc) || Boolean(inlineHref);

  const metaParts = [attachment.mimeType, formatSize(attachment.size)].filter(Boolean).join(' · ');

  return createPortal(
    <div
      className={`${styles.backdrop}${closing ? ` ${styles.closing}` : ''}`}
      onClick={close}
      role="presentation"
    >
      <div
        className={styles.panel}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={attachment.name}
      >
        <div className={styles.header}>
          <div className={styles.titleGroup}>
            <div className={styles.name} title={attachment.name}>{attachment.name}</div>
            {metaParts && <div className={styles.meta}>{metaParts}</div>}
          </div>
          <div className={styles.actions}>
            {canDownload && (
              <button
                type="button"
                className={styles.downloadBtn}
                onClick={handleDownload}
                title="Download"
              >
                Download
              </button>
            )}
            <button type="button" className={styles.closeBtn} onClick={close} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        <div className={styles.body}>
          {attachment.error ? (
            <div className={styles.errorMsg}>{attachment.error}</div>
          ) : imgSrc ? (
            <div className={styles.imageWrap}>
              <img
                src={imgSrc}
                alt={attachment.name}
                className={styles.image}
                onLoad={() => setLoaded(true)}
                onError={() => setLoaded(true)}
              />
            </div>
          ) : pdfSrc ? (
            <iframe
              title={attachment.name}
              src={pdfSrc}
              className={styles.pdfFrame}
              onLoad={() => setLoaded(true)}
            />
          ) : htmlSrc ? (
            // `sandbox=""` disables scripts, same-origin, forms and top
            // navigation — even if the protocol handler's CSP were bypassed
            // the iframe still can't phone home or run JS.
            <iframe
              title={attachment.name}
              src={htmlSrc}
              sandbox=""
              className={styles.pdfFrame}
              onLoad={() => setLoaded(true)}
            />
          ) : textSrc ? (
            // Plain text, source, JSON, CSV, etc. Chromium renders these
            // as monospace text. `sandbox=""` is belt-and-braces — with
            // `nosniff` set by the protocol handler, Chromium can't
            // reclassify the response as HTML.
            <iframe
              title={attachment.name}
              src={textSrc}
              sandbox=""
              className={styles.pdfFrame}
              onLoad={() => setLoaded(true)}
            />
          ) : (
            <div className={styles.emptyMsg}>
              No inline preview available for this file type.
              {canDownload ? ' Use Download to save the file.' : ''}
            </div>
          )}
          {hasPreview && !loaded && (
            // Overlay spinner while the image / iframe is loading. First
            // open has real latency (Chromium spinning up its PDF viewer
            // or streaming a large file) and a blank modal feels broken.
            <div className={styles.loadingOverlay} aria-live="polite" role="status">
              <span className={styles.spinner} aria-hidden="true" />
              <span className={styles.loadingLabel}>Loading preview…</span>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
