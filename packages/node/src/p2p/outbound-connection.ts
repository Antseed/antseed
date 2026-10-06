import type { ConnectionConfig } from "../types/connection.js";
import { ConnectionState } from "../types/connection.js";
import type { PeerId, PeerInfo } from "../types/peer.js";
import { debugLog, debugWarn } from "../utils/debug.js";
import type { ConnectionManager, PeerConnection } from "./connection-manager.js";

export function parsePeerAddress(address: string): { host: string; port: number } {
  const parts = address.split(":");
  return { host: parts[0]!, port: parseInt(parts[1] ?? "6882", 10) };
}

function waitForOpen(conn: PeerConnection, peerId: PeerId): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onState = (state: ConnectionState): void => {
      debugLog(`[Node] Connection state: ${state}`);
      if (state === ConnectionState.Open || state === ConnectionState.Authenticated) {
        conn.off("stateChange", onState);
        resolve();
      } else if (state === ConnectionState.Failed || state === ConnectionState.Closed) {
        conn.off("stateChange", onState);
        reject(new Error(`Connection to ${peerId} failed`));
      }
    };
    conn.on("stateChange", onState);
  });
}

/**
 * The endpoint each outbound connection was opened against. Kept per
 * connection rather than read from ConnectionManager's static endpoint map,
 * which every buyer identity shares: once one identity reconnects to a moved
 * peer, the shared map already holds the new endpoint and would hide the move
 * from the other identities' stale connections.
 */
const connectionEndpoints = new WeakMap<PeerConnection, { host: string; port: number }>();

/**
 * Reuse the live outbound connection to `peer` on `connectionManager`, or
 * open a new one. A connection whose peer moved to a new endpoint (e.g. IP
 * rotation) is closed and replaced. `onOpened` runs once for each newly
 * opened connection so the caller can wire its frame handling.
 */
export async function getOrOpenOutboundConnection(
  connectionManager: ConnectionManager,
  peer: PeerInfo,
  peerCapabilities: Map<PeerId, Set<string>>,
  onOpened: (conn: PeerConnection) => void,
): Promise<PeerConnection> {
  const existing = connectionManager.getConnection(peer.peerId);
  const capabilities = new Set(peer.capabilities ?? peer.metadata?.capabilities ?? []);
  peerCapabilities.set(peer.peerId, capabilities);
  let endpointChanged = false;

  // Only outbound connections have a registered endpoint; inbound ones are
  // not subject to pinned-peer routing.
  if (existing && peer.publicAddress) {
    const currentEndpoint = connectionEndpoints.get(existing);
    const { host: newHost, port: newPort } = parsePeerAddress(peer.publicAddress);
    if (currentEndpoint && (currentEndpoint.host !== newHost || currentEndpoint.port !== newPort)) {
      debugLog(`[Node] Peer ${peer.peerId.slice(0, 12)}... endpoint changed from ${currentEndpoint.host}:${currentEndpoint.port} to ${newHost}:${newPort}, reconnecting`);
      existing.close();
      peerCapabilities.set(peer.peerId, capabilities);
      endpointChanged = true;
    }
  }

  if (
    existing && !endpointChanged &&
    existing.state !== ConnectionState.Closed &&
    existing.state !== ConnectionState.Failed
  ) {
    debugLog(`[Node] Reusing existing connection to ${peer.peerId.slice(0, 12)}... (state=${existing.state})`);
    if (existing.state === ConnectionState.Connecting) {
      debugLog(`[Node] Waiting for connection to open...`);
      await waitForOpen(existing, peer.peerId);
    }
    return existing;
  }

  let endpoint: { host: string; port: number } | undefined;
  if (peer.publicAddress) {
    const { host, port } = parsePeerAddress(peer.publicAddress);
    endpoint = { host, port };
    connectionManager.registerPeerEndpoint(peer.peerId, endpoint);
    debugLog(`[Node] Connecting to ${peer.peerId.slice(0, 12)}... at ${host}:${port}`);
  } else {
    debugWarn(`[Node] Peer ${peer.peerId.slice(0, 12)}... has no public address`);
  }

  const connConfig: ConnectionConfig = {
    remotePeerId: peer.peerId,
    isInitiator: true,
    remoteCapabilities: [...capabilities],
  };
  const conn = connectionManager.createConnection(connConfig);
  if (endpoint) connectionEndpoints.set(conn, endpoint);
  await waitForOpen(conn, peer.peerId);

  debugLog(`[Node] Connected to ${peer.peerId.slice(0, 12)}... via ${conn.transportDescription}`);
  peerCapabilities.set(peer.peerId, capabilities);
  onOpened(conn);
  return conn;
}
