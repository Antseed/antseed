import type { PeerId } from "./peer-id.js";

/** Connection lifecycle states. */
export enum ConnectionState {
  Connecting = "connecting",
  Open = "open",
  Authenticated = "authenticated",
  Closing = "closing",
  Closed = "closed",
  Failed = "failed",
}

/** Events emitted by a PeerConnection. */
export interface ConnectionEvents {
  stateChange: (state: ConnectionState) => void;
  message: (data: Uint8Array) => void;
  error: (err: Error) => void;
}

/** Configuration for a single connection. */
export interface ConnectionConfig {
  remotePeerId: PeerId;
  isInitiator: boolean;
  timeoutMs?: number;
  endpoint?: {
    host: string;
    port: number;
  };
  /** Remote capabilities learned from discovery metadata; gates transport security on outbound connections. */
  remoteCapabilities?: string[];
}
