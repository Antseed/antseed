import { useEffect, useMemo, useRef, useState } from 'react';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { formatClock } from '../../../core/format';
import { VprCard, VprPage } from '../vpr/VprKit';
import styles from './DiagnosticsView.module.scss';

type DesktopViewProps = {
  onSelectView?: (view: import('../../types').ViewName) => void;
};

type RuntimeLogEntry = {
  timestamp: number;
  mode: string;
  stream: string;
  line: string;
};

type LogSourceSummary = {
  source: string;
  count: number;
};

const ALL_SOURCES = '__all__';

function normalizeLogSource(source: string): string {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return 'runtime';
  }
  if (/^proxy$/i.test(trimmed)) {
    return 'proxy';
  }
  return trimmed;
}

function getLogSource(entry: RuntimeLogEntry): string {
  if (entry.stream === 'system') {
    return 'system';
  }

  const prefixMatch = /^\s*\[([^\]]{1,48})\]/.exec(entry.line);
  if (prefixMatch?.[1]) {
    return normalizeLogSource(prefixMatch[1]);
  }

  return entry.stream === 'stderr' ? 'stderr' : 'runtime';
}

function sourceSortRank(source: string): number {
  const normalized = source.toLowerCase();
  if (normalized === 'proxymux') return 0;
  if (normalized === 'paymentmux') return 1;
  if (normalized === 'buyerpayment') return 2;
  if (normalized === 'buyernegotiator') return 3;
  if (normalized === 'buyerrequest') return 4;
  if (normalized === 'proxy') return 5;
  if (normalized === 'node') return 6;
  if (normalized === 'system') return 98;
  if (normalized === 'stderr') return 99;
  return 50;
}

function getLogSources(logs: RuntimeLogEntry[]): LogSourceSummary[] {
  const counts = new Map<string, number>();
  for (const entry of logs) {
    const source = getLogSource(entry);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((left, right) => {
      const rankDelta = sourceSortRank(left.source) - sourceSortRank(right.source);
      if (rankDelta !== 0) return rankDelta;
      return left.source.localeCompare(right.source);
    });
}

function matchesSearch(entry: RuntimeLogEntry, source: string, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }

  return [
    source,
    entry.mode,
    entry.stream,
    entry.line,
  ].some((value) => value.toLowerCase().includes(normalized));
}

function downloadLogs(logs: RuntimeLogEntry[]): void {
  const text = logs.map((e) => `${formatClock(e.timestamp)} [${e.mode}] [${e.stream}] ${e.line}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `antseed-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    URL.revokeObjectURL(url);
  }
}

export function DesktopView({ onSelectView }: DesktopViewProps) {
  const [selectedSource, setSelectedSource] = useState(ALL_SOURCES);
  const [searchQuery, setSearchQuery] = useState('');
  const { logs, daemonState } = useUiSelector((state) => ({
    logs: state.logs,
    daemonState: state.daemonState,
  }), shallowEqual);
  const actions = useActions();
  const logsEndRef = useRef<HTMLDivElement>(null);

  const sourceSummaries = useMemo(() => getLogSources(logs), [logs]);
  const filteredLogs = useMemo(() => logs.filter((entry) => {
    const source = getLogSource(entry);
    return (selectedSource === ALL_SOURCES || source === selectedSource)
      && matchesSearch(entry, source, searchQuery);
  }), [logs, searchQuery, selectedSource]);
  const selectedSourceExists = selectedSource === ALL_SOURCES
    || sourceSummaries.some((summary) => summary.source === selectedSource);

  useEffect(() => {
    const el = logsEndRef.current?.parentElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filteredLogs.length]);

  useEffect(() => {
    if (!selectedSourceExists) {
      setSelectedSource(ALL_SOURCES);
    }
  }, [selectedSourceExists]);

  const daemonText = !daemonState || !daemonState.exists
    ? 'No daemon state file found yet.'
    : !daemonState.state
      ? 'Daemon state file exists but could not be parsed.'
      : JSON.stringify(daemonState.state, null, 2);

  return (
    <section className="view view-desktop view-pinned-header" role="tabpanel">
      <VprPage
        title="Live logs"
        backFallback="help"
        subtitle="Runtime activity as it happens."
        action={(
          <div className={styles.headActions}>
            <button
              type="button"
              className={styles.button}
              onClick={() => downloadLogs(filteredLogs)}
              disabled={filteredLogs.length === 0}
            >
              Download
            </button>
            <button type="button" className={styles.button} onClick={() => void actions.clearLogs()}>
              Clear
            </button>
          </div>
        )}
      >
      <div className={styles.stack}>
        <pre hidden>{daemonText}</pre>

        <VprCard className={styles.card}>
          <span className={styles.cardTitle}>
            Runtime logs
            <span className={styles.cardCount}>{filteredLogs.length} / {logs.length}</span>
          </span>
          <div className={styles.chipRow} role="list" aria-label="Log sources">
            <button
              type="button"
              className={`${styles.chip}${selectedSource === ALL_SOURCES ? ` ${styles.chipActive}` : ''}`}
              onClick={() => setSelectedSource(ALL_SOURCES)}
            >
              All
              <span>{logs.length}</span>
            </button>
            {sourceSummaries.map(({ source, count }) => (
              <button
                key={source}
                type="button"
                className={`${styles.chip}${selectedSource === source ? ` ${styles.chipActive}` : ''}`}
                onClick={() => setSelectedSource(source)}
                title={`Show only ${source} logs`}
              >
                {source}
                <span>{count}</span>
              </button>
            ))}
          </div>
          <input
            type="search"
            className={styles.input}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Filter text, source, stream..."
            aria-label="Filter logs by text"
          />
          <div className={styles.logs} aria-live="polite">
            {filteredLogs.length === 0 && (
              <div className={styles.message}>No logs match the current filter.</div>
            )}
            {filteredLogs.map((entry, i) => (
              <div
                key={`${entry.timestamp}-${i}-${entry.line}`}
                className={`${styles.logEntry}${entry.stream === 'stderr' ? ` ${styles.logError}` : ''}`}
              >
                <div className={styles.logMeta}>
                  <span>{formatClock(entry.timestamp)}</span>
                  <span>{getLogSource(entry)}</span>
                </div>
                <div className={styles.logText}>{`[${entry.mode}] ${entry.line}`}</div>
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </VprCard>
      </div>
      </VprPage>
    </section>
  );
}
