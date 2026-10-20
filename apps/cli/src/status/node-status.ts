import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AntseedConfig } from '../config/types.js';

const DEFAULT_DATA_DIR = join(homedir(), '.antseed');

export interface NodeStatus {
  state: 'seeding' | 'connected' | 'idle';
  peerCount: number;
  earningsToday: string;
  tokensToday: number;
  activeChannels: number;
  uptime: string;
  walletAddress: string | null;
  proxyPort: number | null;
  capacityUsedPercent: number;
  daemonPid: number | null;
  daemonAlive: boolean;
  /** Operator-facing warnings from the running daemon (e.g. out of gas). */
  notices: string[];
}

/** Stale threshold: 30 seconds */
const STALE_THRESHOLD_MS = 30_000;

/** Seller daemon writes daemon.state.json; buyer proxy writes buyer.state.json. */
const STATE_FILES: Array<{ name: string; role: 'seller' | 'buyer' }> = [
  { name: 'daemon.state.json', role: 'seller' },
  { name: 'buyer.state.json', role: 'buyer' },
];

/**
 * Check if a process with the given PID is alive.
 * Uses `process.kill(pid, 0)` which checks existence without sending a signal.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the buyer process that last wrote this data dir's buyer.state.json
 * (`antseed buyer start`, which the desktop app also runs) is still alive.
 * A pid reused by another process reads as alive.
 */
export async function isBuyerProcessAlive(dataDir: string): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(join(dataDir, 'buyer.state.json'), 'utf-8')) as Record<string, unknown>;
    return typeof state.pid === 'number' && isProcessAlive(state.pid);
  } catch {
    return false;
  }
}

interface LoadedStateFile {
  path: string;
  data: Record<string, unknown>;
  role: 'seller' | 'buyer';
}

async function loadStateFile(dataDir: string): Promise<LoadedStateFile | null> {
  for (const { name, role } of STATE_FILES) {
    const path = join(dataDir, name);
    try {
      const raw = await readFile(path, 'utf-8');
      return { path, data: JSON.parse(raw) as Record<string, unknown>, role };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Query the current node status.
 * Reads from the running daemon's state file at <dataDir>/daemon.state.json
 * (seller) or <dataDir>/buyer.state.json (buyer proxy). Uses PID-based
 * liveness check first, falls back to 30s stale threshold. Returns idle state
 * with zeroed metrics if no daemon is running or the state file is stale.
 */
export async function getNodeStatus(config: AntseedConfig, dataDir: string = DEFAULT_DATA_DIR): Promise<NodeStatus> {
  const loaded = await loadStateFile(dataDir);
  if (!loaded) {
    return idleStatus(config, null);
  }

  const { path: stateFilePath, data: state, role } = loaded;

  // PID-based liveness check
  const pid = typeof state.pid === 'number' ? state.pid : null;
  const alive = pid !== null && isProcessAlive(pid);

  // If PID is present and process is dead, return idle immediately
  if (pid !== null && !alive) {
    return idleStatus(config, pid);
  }

  // Fallback: if no PID in state file, use stale threshold
  if (pid === null) {
    const fileStat = await stat(stateFilePath);
    const ageMs = Date.now() - fileStat.mtimeMs;
    if (ageMs > STALE_THRESHOLD_MS) {
      return idleStatus(config, null);
    }
  }

  return role === 'buyer'
    ? buyerStatus(state, config, pid, alive)
    : sellerStatus(state, config, pid, alive);
}

function sellerStatus(
  state: Record<string, unknown>,
  config: AntseedConfig,
  pid: number | null,
  alive: boolean,
): NodeStatus {
  const validStates = ['seeding', 'connected', 'idle'] as const;
  const rawState = typeof state.state === 'string' && validStates.includes(state.state as NodeStatus['state'])
    ? (state.state as NodeStatus['state'])
    : 'idle';

  return {
    state: rawState,
    peerCount: typeof state.peerCount === 'number' ? state.peerCount : 0,
    earningsToday: typeof state.earningsToday === 'string' ? state.earningsToday : '0',
    tokensToday: typeof state.tokensToday === 'number' ? state.tokensToday : 0,
    activeChannels: typeof state.activeChannels === 'number' ? state.activeChannels : 0,
    uptime: typeof state.uptime === 'string' ? state.uptime : '0s',
    walletAddress: typeof state.walletAddress === 'string' ? state.walletAddress : (config.identity.walletAddress ?? null),
    proxyPort: typeof state.proxyPort === 'number' ? state.proxyPort : null,
    capacityUsedPercent: typeof state.capacityUsedPercent === 'number' ? state.capacityUsedPercent : 0,
    daemonPid: pid,
    daemonAlive: alive,
    notices: Array.isArray(state.notices)
      ? state.notices.filter((notice): notice is string => typeof notice === 'string')
      : [],
  };
}

function buyerStatus(
  state: Record<string, unknown>,
  config: AntseedConfig,
  pid: number | null,
  alive: boolean,
): NodeStatus {
  // buyer.state.json uses different field names than daemon.state.json:
  //   - `port` is the proxy port
  //   - `state` is 'connected' | 'stopped' (map 'stopped' to 'idle')
  //   - peerCount is derived from the persisted discoveredPeers cache
  const reportedState = state.state === 'connected' ? 'connected' : 'idle';
  const peers = Array.isArray(state.discoveredPeers) ? state.discoveredPeers : [];

  return {
    state: reportedState,
    peerCount: peers.length,
    earningsToday: '0',
    tokensToday: 0,
    activeChannels: 0,
    uptime: '0s',
    walletAddress: config.identity.walletAddress ?? null,
    proxyPort: typeof state.port === 'number' ? state.port : null,
    capacityUsedPercent: 0,
    daemonPid: pid,
    daemonAlive: alive,
    notices: [],
  };
}

function idleStatus(config: AntseedConfig, pid: number | null): NodeStatus {
  return {
    state: 'idle',
    peerCount: 0,
    earningsToday: '0',
    tokensToday: 0,
    activeChannels: 0,
    uptime: '0s',
    walletAddress: config.identity.walletAddress ?? null,
    proxyPort: null,
    capacityUsedPercent: 0,
    daemonPid: pid,
    daemonAlive: false,
    notices: [],
  };
}
