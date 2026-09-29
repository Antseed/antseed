import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import net, { type Socket } from "node:net";
import type {
  PeerConnection as NativeRtcPeerConnection,
  DataChannel as NativeDataChannel,
  DescriptionType as NativeDescriptionType,
} from "node-datachannel";
import { type PeerId } from "../types/peer.js";
import { ConnectionState, type ConnectionConfig } from "../types/connection.js";
import {
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1,
  CONNECTION_CAPABILITY_SIGNED_SDP_V1,
  CONNECTION_CAPABILITY_TCP_ENC_V1,
  CONNECTION_CAPABILITY_WEBRTC_V1,
} from "../types/protocol.js";
import { type IceConfig, getDefaultIceConfig } from "./ice-config.js";
import type { Wallet } from "ethers";
import {
  type ConnectionAuthEnvelope,
  type TcpEncAckMessage,
  type TcpEncOffer,
  NonceReplayGuard,
  buildConnectionAuthEnvelope,
  buildSdpAuthEnvelope,
  buildTcpEncAck,
  buildTcpEncOffer,
  verifyConnectionAuthEnvelope,
  verifySdpAuthEnvelope,
  verifyTcpEncAck,
  verifyTcpEncOffer,
} from "./connection-auth.js";
import {
  type TransportCrypto,
  createTransportCrypto,
  deriveSessionKeys,
  generateEphemeralKeyPair,
} from "./secure-channel.js";

let _nodeDatachannel: typeof import("node-datachannel") | null = null;

async function loadNodeDatachannel(): Promise<typeof import("node-datachannel")> {
  if (_nodeDatachannel) return _nodeDatachannel;
  _nodeDatachannel = await import("node-datachannel");
  return _nodeDatachannel;
}

const NDC_PROBE_SOURCE =
  "const m = require(process.argv[1]);" +
  "const pc = new m.PeerConnection('antseed-probe', { iceServers: [] });" +
  "const dc = pc.createDataChannel('probe', { ordered: true });" +
  "dc.close(); pc.close();" +
  "process.exit(0);";

/**
 * Exercise node-datachannel in a disposable child process first: a broken
 * native build can segfault, which no in-process try/catch survives. A dead
 * or hung child just means TCP fallback instead of a crashed node.
 */
function probeNodeDatachannelSafely(): Promise<boolean> {
  return new Promise((resolve) => {
    let modulePath: string;
    try {
      modulePath = createRequire(import.meta.url).resolve("node-datachannel");
    } catch {
      resolve(false);
      return;
    }
    execFile(
      process.execPath,
      ["-e", NDC_PROBE_SOURCE, modulePath],
      { timeout: 10_000 },
      (err) => resolve(!err),
    );
  });
}

function getNodeDatachannel(): typeof import("node-datachannel") {
  if (!_nodeDatachannel) throw new Error("node-datachannel not loaded");
  return _nodeDatachannel;
}

export interface PeerEndpoint {
  host: string;
  port: number;
}

type TransportMode = "webrtc" | "tcp";
type MetadataProvider = () => object | null;

export interface ConnectionManagerOptions {
  /** Refuse plaintext TCP and unsigned SDP in both directions. Default false (legacy interop). */
  requireSecureTransport?: boolean;
}
type InitialWireMessage =
  | {
      type: "intro";
      auth: ConnectionAuthEnvelope;
      capabilities?: string[];
      /** transport.tcp-enc.v1 offer; absent on legacy peers. */
      enc?: TcpEncOffer;
    }
  | {
      type: "hello";
      auth: ConnectionAuthEnvelope;
      capabilities?: string[];
    };

type SignalingMessage =
  | {
      type: "sdp";
      sdp: string;
      descriptionType: NativeDescriptionType;
      /** transport.signed-sdp.v1 envelope; absent on legacy peers. */
      auth?: ConnectionAuthEnvelope;
    }
  | {
      type: "candidate";
      candidate: string;
      mid: string;
    };

const DATA_CHANNEL_LABEL = "antseed-data";
const LINE_SEPARATOR = "\n";
const INITIAL_LINE_TIMEOUT_MS = 10_000;
const MAX_INITIAL_LINE_BYTES = 8 * 1024;
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 10_000;
const LOCAL_CONNECTION_CAPABILITIES = [
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1,
  CONNECTION_CAPABILITY_SIGNED_SDP_V1,
  CONNECTION_CAPABILITY_TCP_ENC_V1,
] as const;

/** Represents a single P2P connection. */
export class PeerConnection extends EventEmitter {
  readonly remotePeerId: PeerId;
  readonly isInitiator: boolean;
  private _state: ConnectionState = ConnectionState.Connecting;
  private _timeoutMs: number;
  private _timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private _rtc: NativeRtcPeerConnection | null = null;
  private _dataChannel: NativeDataChannel | null = null;
  private _rawSocket: Socket | null = null;
  private _signalingSocket: Socket | null = null;
  private _remoteCapabilities = new Set<string>();
  private _crypto: TransportCrypto | null = null;
  private _remoteAddress: string | null = null;

  constructor(config: ConnectionConfig) {
    super();
    this.remotePeerId = config.remotePeerId;
    this.isInitiator = config.isInitiator;
    this._timeoutMs = config.timeoutMs ?? 30_000;
  }

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Remote IP of the underlying socket (raw TCP, or the signaling socket for
   * WebRTC), captured when the socket is attached. Null for connections that
   * never had a socket attached (tests, unusual transports).
   */
  get remoteAddress(): string | null {
    return this._remoteAddress;
  }

  setRemoteCapabilities(capabilities: Iterable<string>): void {
    this._remoteCapabilities = new Set(capabilities);
  }

  hasRemoteCapability(capability: string): boolean {
    return this._remoteCapabilities.has(capability);
  }

  attachRtcPeer(rtc: NativeRtcPeerConnection): void {
    this._rtc = rtc;
  }

  attachSignalingSocket(socket: Socket): void {
    this._signalingSocket = socket;
    this._remoteAddress ??= socket.remoteAddress ?? null;
  }

  attachDataChannel(channel: NativeDataChannel): void {
    this._dataChannel = channel;

    channel.onOpen(() => {
      this.clearTimeout();
      if (this._state === ConnectionState.Connecting) {
        this.setState(ConnectionState.Open);
      }
    });

    channel.onClosed(() => {
      if (this._state !== ConnectionState.Closed && this._state !== ConnectionState.Failed) {
        this.setState(ConnectionState.Closed);
      }
    });

    channel.onError((err: string) => {
      this.fail(new Error(`DataChannel error: ${err}`));
    });

    channel.onMessage((msg: string | Buffer) => {
      if (typeof msg === "string") {
        this.emit("message", new TextEncoder().encode(msg));
      } else {
        this.emit("message", new Uint8Array(msg));
      }
    });
  }

  /** True for encrypted TCP framing or a (DTLS) data channel; false for legacy plaintext TCP. */
  get isEncryptedTransport(): boolean {
    return this._crypto !== null || this._dataChannel !== null;
  }

  get transportDescription(): "webrtc" | "tcp-encrypted" | "tcp-plaintext" {
    if (this._dataChannel !== null) return "webrtc";
    if (this._crypto !== null) return "tcp-encrypted";
    return "tcp-plaintext";
  }

  attachRawSocket(socket: Socket, initialData?: Uint8Array, crypto?: TransportCrypto): void {
    this._rawSocket = socket;
    this._remoteAddress = socket.remoteAddress ?? this._remoteAddress;
    this._crypto = crypto ?? null;
    socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);

    const deliver = (chunk: Uint8Array): void => {
      if (!this._crypto) {
        this.emit("message", chunk);
        return;
      }
      let messages: Uint8Array[];
      try {
        messages = this._crypto.decryptor.push(chunk);
      } catch (err) {
        this.fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      for (const message of messages) {
        this.emit("message", message);
      }
    };

    socket.on("data", (chunk: Buffer) => {
      deliver(new Uint8Array(chunk));
    });

    socket.on("error", (err: Error) => {
      this.fail(err);
    });

    socket.on("close", () => {
      if (this._state !== ConnectionState.Closed && this._state !== ConnectionState.Failed) {
        this.setState(ConnectionState.Closed);
      }
    });

    this.clearTimeout();
    if (this._state === ConnectionState.Connecting) {
      this.setState(ConnectionState.Open);
    }

    if (initialData && initialData.length > 0) {
      queueMicrotask(() => {
        deliver(initialData);
      });
    }
  }

  fail(err: Error): void {
    if (this._state !== ConnectionState.Failed && this._state !== ConnectionState.Closed) {
      this.setState(ConnectionState.Failed);
    }
    this._teardownTransports();
    this._emitError(err);
  }

  /** Transition to a new state and emit event. */
  setState(newState: ConnectionState): void {
    if (this._state === newState) return;
    this._state = newState;
    this.emit("stateChange", newState);
  }

  /** Start the connection timeout. */
  startTimeout(): void {
    this._timeoutHandle = setTimeout(() => {
      if (this._state === ConnectionState.Connecting) {
        this.fail(new Error(`Connection to ${this.remotePeerId} timed out`));
      }
    }, this._timeoutMs);
  }

  /** Clear the connection timeout. */
  clearTimeout(): void {
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  /** Send a message through the active transport. */
  send(data: Uint8Array): void {
    if (this._state !== ConnectionState.Open && this._state !== ConnectionState.Authenticated) {
      throw new Error(`Cannot send in state ${this._state}`);
    }

    if (this._dataChannel && this._dataChannel.isOpen()) {
      // node-datachannel can THROW ("Cannot send message on destroyed
      // socket") when the peer tears the channel down between isOpen() and
      // this call — a common race with browser buyers that connect and drop
      // freely. The throw crosses a native boundary and aborts the process if
      // it escapes, so convert it into a graceful connection failure.
      let ok: boolean;
      try {
        ok = this._dataChannel.sendMessageBinary(data);
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        this.fail(wrapped);
        throw wrapped;
      }
      if (!ok) {
        const err = new Error(`Failed to send data to ${this.remotePeerId}`);
        this.fail(err);
        throw err;
      }
      return;
    }

    if (!this._rawSocket || this._rawSocket.destroyed || !this._rawSocket.writable) {
      // Transport is unexpectedly unavailable while state is Open — eagerly fail the
      // connection so it is evicted from the pool and the next request gets a fresh
      // connection instead of also hitting this error.
      const err = new Error(`Cannot send to ${this.remotePeerId}: no writable transport`);
      this.fail(err);
      throw err;
    }

    if (this._crypto) {
      let frame: Buffer;
      try {
        frame = this._crypto.encryptor.encrypt(data);
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        this.fail(wrapped);
        throw wrapped;
      }
      this._rawSocket.write(frame);
      return;
    }

    this._rawSocket.write(Buffer.from(data));
  }

  /** Close the connection gracefully. */
  close(): void {
    if (this._state === ConnectionState.Closed) {
      return;
    }

    this.clearTimeout();
    this.setState(ConnectionState.Closing);
    this._teardownTransports();
    this.setState(ConnectionState.Closed);
    this.removeAllListeners();
  }

  private _teardownTransports(): void {
    if (this._dataChannel) {
      try {
        this._dataChannel.close();
      } catch {
        // best effort close
      }
      this._dataChannel = null;
    }

    if (this._rtc) {
      try {
        this._rtc.close();
      } catch {
        // best effort close
      }
      this._rtc = null;
    }

    if (this._rawSocket && !this._rawSocket.destroyed) {
      this._rawSocket.destroy();
    }
    this._rawSocket = null;

    if (this._signalingSocket && !this._signalingSocket.destroyed) {
      this._signalingSocket.destroy();
    }
    this._signalingSocket = null;
  }

  private _emitError(err: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const capabilities: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 128) {
      continue;
    }
    capabilities.push(item);
  }
  return capabilities;
}

/** Manages all peer connections and optional inbound listening. */
export class ConnectionManager extends EventEmitter {
  private _connections = new Map<PeerId, PeerConnection>();
  private _iceConfig: IceConfig;
  private _localPeerId: PeerId | null = null;
  private _localWallet: Wallet | null = null;
  private _listenHost = "127.0.0.1";
  private _listenPort: number | null = null;
  private _server: net.Server | null = null;
  private _transportMode: TransportMode;
  private _metadataProvider: MetadataProvider | null = null;
  private _requireSecureTransport: boolean;
  private _ipConnectionCounts = new Map<string, number>();
  private readonly _introReplayGuard = new NonceReplayGuard();
  private static _knownEndpoints = new Map<PeerId, PeerEndpoint>();
  private static _detectedTransportMode: TransportMode | null = null;

  constructor(iceConfig?: IceConfig, options?: ConnectionManagerOptions) {
    super();
    this._iceConfig = iceConfig ?? getDefaultIceConfig();
    this._transportMode = ConnectionManager._detectTransportMode();
    this._requireSecureTransport = options?.requireSecureTransport ?? false;
  }

  static async init(iceConfig?: IceConfig, options?: ConnectionManagerOptions): Promise<ConnectionManager> {
    if (_nodeDatachannel || await probeNodeDatachannelSafely()) {
      try {
        await loadNodeDatachannel();
      } catch {
        // node-datachannel not available — TCP fallback will be used
      }
    }
    return new ConnectionManager(iceConfig, options);
  }

  get iceConfig(): IceConfig {
    return this._iceConfig;
  }

  /** True when node-datachannel loaded and the probe succeeded. */
  get supportsWebRtc(): boolean {
    return this._transportMode === "webrtc";
  }

  private _localCapabilities(): string[] {
    return this.supportsWebRtc
      ? [...LOCAL_CONNECTION_CAPABILITIES, CONNECTION_CAPABILITY_WEBRTC_V1]
      : [...LOCAL_CONNECTION_CAPABILITIES];
  }

  get connections(): ReadonlyMap<PeerId, PeerConnection> {
    return this._connections;
  }

  getListeningPort(): number | null {
    return this._listenPort;
  }

  setMetadataProvider(provider: MetadataProvider): void {
    this._metadataProvider = provider;
  }

  setLocalPeerId(peerId: PeerId): void {
    this._localPeerId = peerId;
  }

  setLocalIdentity(identity: { peerId: PeerId; wallet: Wallet }): void {
    this._localPeerId = identity.peerId;
    this._localWallet = identity.wallet;
  }

  static registerPeerEndpoint(peerId: PeerId, endpoint: PeerEndpoint): void {
    this._knownEndpoints.set(peerId, endpoint);
  }

  static resolvePeerEndpoint(peerId: PeerId): PeerEndpoint | undefined {
    return this._knownEndpoints.get(peerId);
  }

  registerPeerEndpoint(peerId: PeerId, endpoint: PeerEndpoint): void {
    ConnectionManager.registerPeerEndpoint(peerId, endpoint);
  }

  async startListening(config: { peerId: PeerId; port: number; host?: string }): Promise<void> {
    this._localPeerId = config.peerId;
    this._listenHost = config.host ?? "127.0.0.1";
    this._listenPort = config.port;

    if (this._server) {
      return;
    }

    this._server = net.createServer((socket) => {
      const ip = socket.remoteAddress ?? 'unknown';
      const current = this._ipConnectionCounts.get(ip) ?? 0;
      if (current >= 10) {
        socket.destroy();
        return;
      }
      this._ipConnectionCounts.set(ip, current + 1);
      // Keepalive set here for all inbound sockets (WebRTC signaling + TCP).
      // TCP ("intro") sockets will have it re-applied in attachRawSocket — harmless.
      socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
      socket.once('close', () => {
        const count = this._ipConnectionCounts.get(ip) ?? 1;
        if (count <= 1) {
          this._ipConnectionCounts.delete(ip);
        } else {
          this._ipConnectionCounts.set(ip, count - 1);
        }
      });
      this._handleInboundSocket(socket);
    });

    this._server.maxConnections = 256;

    await new Promise<void>((resolve, reject) => {
      this._server!.once("error", reject);
      this._server!.listen(this._listenPort!, this._listenHost, () => resolve());
    });

    // Resolve actual bound port (important when port 0 is used for OS-assigned)
    const addr = this._server.address();
    if (addr && typeof addr !== 'string') {
      this._listenPort = addr.port;
    }

    ConnectionManager.registerPeerEndpoint(config.peerId, {
      host: this._listenHost,
      port: this._listenPort,
    });
  }

  async stopListening(): Promise<void> {
    if (!this._server) {
      return;
    }

    const server = this._server;
    this._server = null;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    if (this._localPeerId) {
      ConnectionManager._knownEndpoints.delete(this._localPeerId);
    }
  }

  /** Create a new outbound connection. */
  createConnection(config: ConnectionConfig): PeerConnection {
    const existing = this._connections.get(config.remotePeerId);
    if (existing && existing.state !== ConnectionState.Closed && existing.state !== ConnectionState.Failed) {
      throw new Error(`Connection to ${config.remotePeerId} already exists`);
    }

    const conn = new PeerConnection(config);
    if (config.remoteCapabilities && config.remoteCapabilities.length > 0) {
      conn.setRemoteCapabilities(config.remoteCapabilities);
    }
    this._registerConnection(config.remotePeerId, conn);
    conn.startTimeout();

    if (!this._localPeerId) {
      queueMicrotask(() => {
        conn.fail(new Error("Local peer id is not configured"));
      });
      return conn;
    }
    if (!this._localWallet) {
      queueMicrotask(() => {
        conn.fail(new Error("Local wallet is not configured"));
      });
      return conn;
    }

    const endpoint = config.endpoint ?? ConnectionManager.resolvePeerEndpoint(config.remotePeerId);
    if (!endpoint) {
      queueMicrotask(() => {
        conn.fail(new Error(`No endpoint registered for peer ${config.remotePeerId}`));
      });
      return conn;
    }

    ConnectionManager.registerPeerEndpoint(config.remotePeerId, endpoint);

    // Encrypted TCP is preferred: data channels cap messages at ~256 KiB
    // (breaking 1 MiB protocol chunks) and set up slower. WebRTC is for peers
    // that cannot do TCP at all; legacy peers crash-guard `hello` away, so
    // unknown peers also get TCP.
    const useWebRtc = this._transportMode === "webrtc"
      && conn.hasRemoteCapability(CONNECTION_CAPABILITY_WEBRTC_V1)
      && !conn.hasRemoteCapability(CONNECTION_CAPABILITY_TCP_ENC_V1);
    if (useWebRtc) {
      this._createWebRtcConnection(config, conn, endpoint);
    } else {
      this._createTcpConnection(config, conn, endpoint);
    }

    return conn;
  }

  /** Get an existing connection by peer ID. */
  getConnection(peerId: PeerId): PeerConnection | undefined {
    return this._connections.get(peerId);
  }

  /** Close a specific connection. */
  closeConnection(peerId: PeerId): void {
    const conn = this._connections.get(peerId);
    if (conn) {
      conn.close();
    }
  }

  /** Close all connections and clean up. */
  closeAll(): void {
    for (const conn of this._connections.values()) {
      conn.close();
    }
    this._connections.clear();
    if (this._server) {
      void this.stopListening();
    }
  }

  private _createWebRtcConnection(
    config: ConnectionConfig,
    conn: PeerConnection,
    endpoint: PeerEndpoint,
  ): void {
    const signalingSocket = net.connect({ host: endpoint.host, port: endpoint.port });
    signalingSocket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
    conn.attachSignalingSocket(signalingSocket);

    let rtc: NativeRtcPeerConnection | null = null;
    const pendingSignals: SignalingMessage[] = [];

    this._attachSignalingParser(
      signalingSocket,
      (msg) => {
        if (!rtc) {
          pendingSignals.push(msg);
          return;
        }
        this._applySignalToRtc(rtc, msg, conn);
      },
      (err) => conn.fail(err),
      "",
    );

    signalingSocket.once("connect", () => {
      const capabilities = this._localCapabilities();
      this._sendLine(signalingSocket, {
        type: "hello",
        auth: buildConnectionAuthEnvelope(
          "hello",
          this._localPeerId!,
          this._localWallet!,
          Date.now(),
          { capabilities },
        ),
        capabilities,
      });

      rtc = this._createRtcPeer(config.remotePeerId);
      conn.attachRtcPeer(rtc);
      this._wireRtcPeer(conn, rtc, signalingSocket, true);

      for (const signal of pendingSignals) {
        this._applySignalToRtc(rtc, signal, conn);
      }
      pendingSignals.length = 0;
    });

    signalingSocket.on("error", (err: Error) => {
      if (conn.state === ConnectionState.Connecting) {
        conn.fail(err);
      }
    });

    signalingSocket.on("close", () => {
      if (conn.state === ConnectionState.Connecting) {
        conn.fail(new Error(`Signaling socket closed before connection to ${config.remotePeerId} opened`));
      }
    });
  }

  private _createTcpConnection(
    config: ConnectionConfig,
    conn: PeerConnection,
    endpoint: PeerEndpoint,
  ): void {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port });

    // Once offered, the handshake fails closed on timeout — never a plaintext downgrade.
    const useEncryption =
      this._requireSecureTransport || conn.hasRemoteCapability(CONNECTION_CAPABILITY_TCP_ENC_V1);

    socket.once("connect", () => {
      const capabilities = this._localCapabilities();

      if (!useEncryption) {
        // Legacy plaintext path keeps the v1 envelope old responders can verify.
        this._sendLine(socket, {
          type: "intro",
          auth: buildConnectionAuthEnvelope("intro", this._localPeerId!, this._localWallet!),
          capabilities,
        });
        conn.attachRawSocket(socket);
        return;
      }

      const ephemeral = generateEphemeralKeyPair();
      // v2 envelope binds capabilities and the enc key, so stripping either
      // downgrades to an unverifiable signature instead of plaintext.
      const auth = buildConnectionAuthEnvelope(
        "intro",
        this._localPeerId!,
        this._localWallet!,
        Date.now(),
        { capabilities, encPub: ephemeral.publicKeyHex },
      );
      this._sendLine(socket, {
        type: "intro",
        auth,
        capabilities,
        enc: buildTcpEncOffer(
          this._localWallet!,
          this._localPeerId!,
          auth.ts,
          auth.nonce,
          ephemeral.publicKeyHex,
        ),
      });

      // Everything after the enc-ack line is encrypted frames.
      this._readSingleLine(socket, (line, remaining) => {
        let ack: Partial<TcpEncAckMessage>;
        try {
          ack = JSON.parse(line) as Partial<TcpEncAckMessage>;
        } catch {
          conn.fail(new Error(`Peer ${config.remotePeerId} sent an invalid enc-ack`));
          socket.destroy();
          return;
        }

        const verified = verifyTcpEncAck({
          ack,
          expectedPeerId: config.remotePeerId,
          initiatorNonce: auth.nonce,
        });
        if (!verified.ok) {
          conn.fail(new Error(`Encrypted transport handshake with ${config.remotePeerId} failed: ${verified.reason}`));
          socket.destroy();
          return;
        }

        const keys = deriveSessionKeys(
          ephemeral.privateKey,
          ack.pub!,
          {
            initiatorPeerId: this._localPeerId!,
            responderPeerId: config.remotePeerId,
            initiatorNonce: auth.nonce,
            responderNonce: ack.nonce!,
            initiatorPubHex: ephemeral.publicKeyHex,
            responderPubHex: ack.pub!,
          },
          true,
        );
        conn.attachRawSocket(
          socket,
          remaining.length > 0 ? new Uint8Array(remaining) : undefined,
          createTransportCrypto(keys),
        );
      });
    });

    socket.on("error", (err: Error) => {
      if (conn.state === ConnectionState.Connecting) {
        conn.fail(err);
      }
    });

    socket.on("close", () => {
      if (conn.state === ConnectionState.Connecting) {
        conn.fail(new Error(`TCP socket closed before connection to ${config.remotePeerId} opened`));
      }
    });
  }

  /** Buffer until the first newline, then detach and hand over line + remaining bytes. */
  private _readSingleLine(
    socket: Socket,
    onLine: (line: string, remaining: Buffer) => void,
  ): void {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const lineBreak = buffer.indexOf(0x0a); // '\n'
      if (lineBreak < 0) {
        if (buffer.length > MAX_INITIAL_LINE_BYTES) {
          socket.off("data", onData);
          socket.destroy();
        }
        return;
      }
      // Only the line itself is size-limited — the same chunk may carry
      // payload bytes (e.g. an encrypted frame right after the enc-ack).
      if (lineBreak > MAX_INITIAL_LINE_BYTES) {
        socket.off("data", onData);
        socket.destroy();
        return;
      }
      socket.off("data", onData);
      const line = buffer.subarray(0, lineBreak).toString("utf8").trim();
      const remaining = buffer.subarray(lineBreak + 1);
      onLine(line, remaining);
    };
    socket.on("data", onData);
  }

  private _handleInboundSocket(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      socket.destroy();
    }, INITIAL_LINE_TIMEOUT_MS);

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const lineBreak = buffer.indexOf(0x0a); // '\n'
      if (lineBreak < 0) {
        if (buffer.length > MAX_INITIAL_LINE_BYTES) {
          socket.off("data", onData);
          clearTimeout(timeout);
          socket.destroy();
        }
        return;
      }
      if (lineBreak > MAX_INITIAL_LINE_BYTES) {
        socket.off("data", onData);
        clearTimeout(timeout);
        socket.destroy();
        return;
      }

      socket.off("data", onData);
      clearTimeout(timeout);

      const line = buffer.subarray(0, lineBreak).toString("utf8").trim();
      const remaining = buffer.subarray(lineBreak + 1);

      // Detect HTTP requests (metadata endpoint served on signaling port)
      if (line.startsWith("GET ") || line.startsWith("HEAD ")) {
        this._serveHttpMetadata(socket, line);
        return;
      }

      let intro: InitialWireMessage;
      try {
        intro = JSON.parse(line) as InitialWireMessage;
      } catch {
        socket.destroy();
        return;
      }
      if (intro.type !== "intro" && intro.type !== "hello") {
        socket.destroy();
        return;
      }

      const wireEncPub = intro.type === "intro" && typeof intro.enc?.pub === "string"
        ? intro.enc.pub
        : null;
      const verified = verifyConnectionAuthEnvelope({
        type: intro.type,
        auth: intro.auth,
        wireCapabilities: intro.capabilities,
        wireEncPub,
        replayGuard: this._introReplayGuard,
      });
      if (!verified.ok || !verified.peerId) {
        socket.destroy();
        return;
      }

      const remoteCapabilities = normalizeCapabilities(intro.capabilities);

      if (intro.type === "intro") {
        if (intro.enc) {
          this._acceptEncryptedTcpInbound(socket, verified.peerId, intro, remaining, remoteCapabilities);
          return;
        }
        if (this._requireSecureTransport) {
          socket.destroy();
          return;
        }
        this._acceptTcpInbound(socket, verified.peerId, remaining, remoteCapabilities);
        return;
      }

      if (intro.type === "hello") {
        if (this._transportMode !== "webrtc") {
          // No working WebRTC stack — refuse instead of crashing on rtc creation.
          socket.destroy();
          return;
        }
        this._acceptWebRtcInbound(socket, verified.peerId, remaining.toString("utf8"), remoteCapabilities);
        return;
      }

      socket.destroy();
    };

    socket.on("data", onData);
    socket.on("error", (err: Error) => {
      clearTimeout(timeout);
      // ECONNRESET / EPIPE are expected when scanners or bots drop the
      // connection before sending the intro — suppress to avoid log noise.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED") {
        return;
      }
      this._emitError(err);
    });
    socket.on("close", () => {
      clearTimeout(timeout);
    });
  }

  private _serveHttpMetadata(socket: Socket, requestLine: string): void {
    const MAX_HEADER_SIZE = 8 * 1024; // 8KB
    let headerBytes = 0;
    const headerTimeout = setTimeout(() => {
      socket.destroy();
    }, 5_000);

    const onData = (chunk: Buffer): void => {
      headerBytes += chunk.length;
      if (headerBytes > MAX_HEADER_SIZE) {
        clearTimeout(headerTimeout);
        socket.off("data", onData);
        socket.destroy();
        return;
      }
      if (chunk.includes(Buffer.from("\r\n\r\n")) || chunk.includes(Buffer.from("\n\n"))) {
        clearTimeout(headerTimeout);
        socket.off("data", onData);
      }
    };
    socket.on("data", onData);

    const url = requestLine.split(" ")[1] ?? "";
    let statusLine: string;
    let body: string;

    if (url !== "/metadata") {
      statusLine = "404 Not Found";
      body = JSON.stringify({ error: "not found" });
    } else if (!this._metadataProvider) {
      statusLine = "503 Service Unavailable";
      body = JSON.stringify({ error: "metadata not available" });
    } else {
      const metadata = this._metadataProvider();
      if (!metadata) {
        statusLine = "503 Service Unavailable";
        body = JSON.stringify({ error: "metadata not available" });
      } else {
        statusLine = "200 OK";
        body = JSON.stringify(metadata);
      }
    }

    socket.end(
      `HTTP/1.1 ${statusLine}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Date: ${new Date().toUTCString()}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      body,
    );
  }

  private _acceptEncryptedTcpInbound(
    socket: Socket,
    remotePeerId: PeerId,
    intro: Extract<InitialWireMessage, { type: "intro" }>,
    remainingData: Buffer,
    remoteCapabilities: string[],
  ): void {
    if (!this._localPeerId || !this._localWallet) {
      // No wallet — cannot sign a valid ack.
      socket.destroy();
      return;
    }

    const offerVerified = verifyTcpEncOffer({
      offer: intro.enc,
      peerId: remotePeerId,
      introTs: intro.auth.ts,
      introNonce: intro.auth.nonce,
    });
    if (!offerVerified.ok) {
      socket.destroy();
      return;
    }

    const ephemeral = generateEphemeralKeyPair();
    const ack = buildTcpEncAck(
      this._localWallet,
      this._localPeerId,
      ephemeral.publicKeyHex,
      intro.auth.nonce,
    );
    this._sendLine(socket, ack);

    const keys = deriveSessionKeys(
      ephemeral.privateKey,
      intro.enc!.pub,
      {
        initiatorPeerId: remotePeerId,
        responderPeerId: this._localPeerId,
        initiatorNonce: intro.auth.nonce,
        responderNonce: ack.nonce,
        initiatorPubHex: intro.enc!.pub,
        responderPubHex: ephemeral.publicKeyHex,
      },
      false,
    );
    this._acceptTcpInbound(socket, remotePeerId, remainingData, remoteCapabilities, createTransportCrypto(keys));
  }

  private _acceptTcpInbound(
    socket: Socket,
    remotePeerId: PeerId,
    remainingData: Buffer,
    remoteCapabilities: string[],
    crypto?: TransportCrypto,
  ): void {
    const existing = this._connections.get(remotePeerId);
    if (existing && existing.state !== ConnectionState.Closed && existing.state !== ConnectionState.Failed) {
      // Replace stale/ghost connections from the same peer instead of rejecting
      // fresh reconnect attempts, which can leave buyers stuck on dead links.
      existing.close();
    }

    const conn = new PeerConnection({
      remotePeerId,
      isInitiator: false,
    });
    conn.setRemoteCapabilities(remoteCapabilities);
    this._registerConnection(remotePeerId, conn);
    conn.attachRawSocket(
      socket,
      remainingData.length > 0 ? new Uint8Array(remainingData) : undefined,
      crypto,
    );
    this.emit("connection", conn);
  }

  private _acceptWebRtcInbound(
    socket: Socket,
    remotePeerId: PeerId,
    initialSignalingBuffer: string,
    remoteCapabilities: string[],
  ): void {
    const existing = this._connections.get(remotePeerId);
    if (existing && existing.state !== ConnectionState.Closed && existing.state !== ConnectionState.Failed) {
      // Replace stale/ghost connections from the same peer instead of rejecting
      // fresh reconnect attempts, which can leave buyers stuck on dead links.
      existing.close();
    }

    const conn = new PeerConnection({
      remotePeerId,
      isInitiator: false,
    });
    conn.setRemoteCapabilities(remoteCapabilities);
    conn.attachSignalingSocket(socket);
    this._registerConnection(remotePeerId, conn);

    let rtc: NativeRtcPeerConnection;
    try {
      rtc = this._createRtcPeer(remotePeerId);
      conn.attachRtcPeer(rtc);
      this._wireRtcPeer(conn, rtc, socket, false);
    } catch (err) {
      conn.fail(err instanceof Error ? err : new Error(String(err)));
      socket.destroy();
      return;
    }

    this._attachSignalingParser(
      socket,
      (msg) => {
        this._applySignalToRtc(rtc, msg, conn);
      },
      (err) => conn.fail(err),
      initialSignalingBuffer,
    );

    socket.on("close", () => {
      if (conn.state === ConnectionState.Connecting) {
        conn.fail(new Error(`Inbound signaling from ${remotePeerId} closed before connection opened`));
      }
    });

    socket.on("error", (err: Error) => {
      conn.fail(err);
    });

    this.emit("connection", conn);
  }

  private _wireRtcPeer(
    conn: PeerConnection,
    rtc: NativeRtcPeerConnection,
    signalingSocket: Socket,
    isInitiator: boolean,
  ): void {
    rtc.onLocalDescription((sdp: string, descriptionType: string) => {
      const normalizedType = this._normalizeDescriptionType(descriptionType);
      // Signing the SDP binds its DTLS fingerprint to our identity.
      const auth = this._localPeerId && this._localWallet
        ? buildSdpAuthEnvelope(this._localPeerId, this._localWallet, normalizedType, sdp)
        : undefined;
      this._sendLine(signalingSocket, {
        type: "sdp",
        sdp,
        descriptionType: normalizedType,
        ...(auth ? { auth } : {}),
      });
    });

    rtc.onLocalCandidate((candidate: string, mid: string) => {
      this._sendLine(signalingSocket, {
        type: "candidate",
        candidate,
        mid,
      });
    });

    rtc.onStateChange((state: string) => {
      const lower = state.toLowerCase();
      if (lower === "failed" || lower === "disconnected" || lower === "closed") {
        if (conn.state === ConnectionState.Connecting || conn.state === ConnectionState.Open) {
          conn.fail(new Error(`WebRTC state is ${state}`));
        } else if (conn.state === ConnectionState.Authenticated) {
          conn.close();
        }
      }
    });

    if (isInitiator) {
      const channel = rtc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
      conn.attachDataChannel(channel);
      rtc.setLocalDescription();
    } else {
      rtc.onDataChannel((channel: NativeDataChannel) => {
        conn.attachDataChannel(channel);
      });
    }
  }

  private _createRtcPeer(remotePeerId: PeerId): NativeRtcPeerConnection {
    const ndc = getNodeDatachannel();
    const iceServers = this._iceConfig.iceServers.flatMap((server) => {
      return Array.isArray(server.urls) ? server.urls : [server.urls];
    });

    return new ndc.PeerConnection(`antseed-${remotePeerId.slice(0, 12)}`, {
      iceServers,
      iceTransportPolicy: this._iceConfig.iceTransportPolicy ?? "all",
    });
  }

  private _applySignalToRtc(
    rtc: NativeRtcPeerConnection,
    signal: SignalingMessage,
    conn: PeerConnection,
  ): void {
    try {
      if (signal.type === "sdp") {
        if (signal.auth) {
          const verified = verifySdpAuthEnvelope({
            auth: signal.auth,
            expectedPeerId: conn.remotePeerId,
            descriptionType: signal.descriptionType,
            sdp: signal.sdp,
            replayGuard: this._introReplayGuard,
          });
          if (!verified.ok) {
            conn.fail(new Error(`SDP signature from ${conn.remotePeerId} rejected: ${verified.reason}`));
            return;
          }
        } else if (
          this._requireSecureTransport
          || conn.hasRemoteCapability(CONNECTION_CAPABILITY_SIGNED_SDP_V1)
        ) {
          // Peer is known to sign its SDP — unsigned means a stripped signature.
          conn.fail(new Error(`Peer ${conn.remotePeerId} sent unsigned SDP`));
          return;
        }
        rtc.setRemoteDescription(signal.sdp, signal.descriptionType);
      } else {
        // Candidates stay unsigned: DTLS still verifies the cert against the
        // signed SDP fingerprint, so tampering can only break connectivity.
        rtc.addRemoteCandidate(signal.candidate, signal.mid);
      }
    } catch (err) {
      conn.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private _attachSignalingParser(
    socket: Socket,
    onMessage: (msg: SignalingMessage) => void,
    onError: (err: Error) => void,
    initialBuffer: string,
  ): void {
    const MAX_BUFFER_SIZE = 64 * 1024; // 64KB
    let buffer = initialBuffer;

    const processBuffer = (): void => {
      while (true) {
        const lineBreak = buffer.indexOf(LINE_SEPARATOR);
        if (lineBreak < 0) {
          break;
        }

        const line = buffer.slice(0, lineBreak).trim();
        buffer = buffer.slice(lineBreak + LINE_SEPARATOR.length);
        if (line.length === 0) {
          continue;
        }

        try {
          const parsed = JSON.parse(line) as SignalingMessage;
          onMessage(parsed);
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }
    };

    if (buffer.length > 0) {
      processBuffer();
    }

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_BUFFER_SIZE) {
        socket.destroy(new Error("Signaling buffer exceeded 64KB limit"));
        return;
      }
      processBuffer();
    });
  }

  private _sendLine(socket: Socket, payload: object): void {
    if (socket.destroyed) {
      throw new Error("Cannot send message on destroyed socket");
    }
    socket.write(JSON.stringify(payload) + LINE_SEPARATOR);
  }

  private _registerConnection(peerId: PeerId, conn: PeerConnection): void {
    this._connections.set(peerId, conn);

    conn.on("stateChange", (state: ConnectionState) => {
      this.emit("connectionStateChange", peerId, state);
      if (state === ConnectionState.Closed || state === ConnectionState.Failed) {
        // Only delete if this exact instance is still the active mapping.
        // A newer replacement connection may already exist for the same peer.
        if (this._connections.get(peerId) === conn) {
          this._connections.delete(peerId);
        }
      }
    });

    conn.on("error", (err: Error) => {
      this._emitError(err);
    });
  }

  private static _detectTransportMode(): TransportMode {
    if (this._detectedTransportMode) {
      return this._detectedTransportMode;
    }

    try {
      const ndc = _nodeDatachannel;
      if (!ndc) {
        this._detectedTransportMode = "tcp";
        return this._detectedTransportMode;
      }
      const probe = new ndc.PeerConnection("antseed-transport-probe", { iceServers: [] });
      try {
        const channel = probe.createDataChannel("probe", { ordered: true });
        channel.close();
      } finally {
        probe.close();
      }
      this._detectedTransportMode = "webrtc";
    } catch {
      this._detectedTransportMode = "tcp";
    }

    return this._detectedTransportMode;
  }

  private _normalizeDescriptionType(type: string): NativeDescriptionType {
    switch (type) {
      case "offer":
      case "answer":
      case "pranswer":
      case "rollback":
      case "unspec":
        return type as NativeDescriptionType;
      default:
        return "unspec" as NativeDescriptionType;
    }
  }

  private _emitError(err: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
  }
}
