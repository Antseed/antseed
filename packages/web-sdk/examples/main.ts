/**
 * Browser example for @antseed/web-sdk: list sellers via a relay, connect
 * over WebRTC, and stream a chat completion. Bundled by the package's
 * `example` script (esbuild); see example.html for the markup.
 */

import { Wallet } from 'ethers';
import { CONNECTION_CAPABILITY_WEBRTC_V1 } from '@antseed/protocol/messages';
import {
  AntseedWebClient,
  type BuyerPeerView,
  type SellerSession,
  type SellerSummary,
} from '../src/index.js';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const relayUrlInput = el<HTMLInputElement>('relayUrl');
const privateKeyInput = el<HTMLInputElement>('privateKey');
const providerInput = el<HTMLInputElement>('provider');
const modelInput = el<HTMLInputElement>('model');
const promptInput = el<HTMLTextAreaElement>('prompt');
const sellersDiv = el<HTMLDivElement>('sellers');
const statusDiv = el<HTMLDivElement>('status');
const outputDiv = el<HTMLDivElement>('output');
const sendButton = el<HTMLButtonElement>('send');

let client: AntseedWebClient | null = null;
let session: SellerSession | null = null;

function status(message: string): void {
  statusDiv.textContent = message;
}

const debugLines: string[] = [];
function debug(message: string): void {
  debugLines.push(`+${(performance.now() / 1000).toFixed(1)}s ${message}`);
  outputDiv.textContent = debugLines.slice(-30).join('\n');
}

/** RTCPeerConnection that narrates its lifecycle into the output box. */
class DebugRTCPeerConnection extends RTCPeerConnection {
  constructor(config?: RTCConfiguration) {
    super(config);
    debug('pc created');
    this.addEventListener('icegatheringstatechange', () => debug(`ice gathering: ${this.iceGatheringState}`));
    this.addEventListener('iceconnectionstatechange', () => debug(`ice: ${this.iceConnectionState}`));
    this.addEventListener('connectionstatechange', () => debug(`pc: ${this.connectionState}`));
    this.addEventListener('icecandidateerror', (event) => {
      const e = event as RTCPeerConnectionIceErrorEvent;
      debug(`ice candidate error: ${e.errorCode} ${e.errorText ?? ''}`);
    });
  }
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    debug(`remote ${desc.type} received`);
    return super.setRemoteDescription(desc);
  }
}

/** WebSocket that narrates the signaling exchange into the output box. */
class DebugWebSocket extends WebSocket {
  constructor(url: string | URL) {
    super(url);
    debug(`ws open attempt: ${String(url).slice(0, 60)}…`);
    this.addEventListener('open', () => debug('ws open'));
    this.addEventListener('error', () => debug('ws error'));
    this.addEventListener('close', (e) => debug(`ws closed code=${e.code} reason=${e.reason || '-'}`));
    this.addEventListener('message', (e) => {
      const text = typeof e.data === 'string' ? e.data : '(binary)';
      debug(`ws << ${text.slice(0, 48)}`);
    });
  }
  send(data: string): void {
    debug(`ws >> ${String(data).slice(0, 48)}`);
    super.send(data);
  }
}

el('generate').onclick = () => {
  privateKeyInput.value = Wallet.createRandom().privateKey;
};

el('listSellers').onclick = async () => {
  try {
    session?.close();
    session = null;
    client?.closeAll();
    if (!privateKeyInput.value.trim()) privateKeyInput.value = Wallet.createRandom().privateKey;

    client = new AntseedWebClient({
      relayUrl: relayUrlInput.value.trim(),
      privateKey: privateKeyInput.value.trim(),
      env: {
        RTCPeerConnection: DebugRTCPeerConnection,
        WebSocket: DebugWebSocket as unknown as never,
      },
      connection: {
        onConnectionInfo: (info) => debug(`connected — WebRTC path: ${info.path}`),
      },
    });
    status(`Buyer peerId: ${client.peerId}\nFetching sellers…`);

    const sellers = await client.sellers();
    if (sellers.length === 0) {
      sellersDiv.textContent = 'Relay reports no sellers. Is one running and discoverable?';
      return;
    }
    // Only sellers announcing a public TCP signaling address can be reached
    // through the relay bridge; NAT-bound sellers are listed but not connectable.
    // Sellers announcing transport.webrtc.v1 run an updated node with working
    // WebRTC natives; legacy nodes reset a browser hello.
    const isLocal = (s: SellerSummary): boolean => {
      const a = String(s.publicAddress ?? '');
      return a.startsWith('127.') || a.startsWith('localhost');
    };
    const rank = (s: SellerSummary): number =>
      isLocal(s) ? 2 : supportsWebrtc(s) ? 1 : 0;
    const bridgeable = sellers
      .filter((seller) => seller.publicAddress)
      .sort((a, b) => rank(b) - rank(a));
    sellersDiv.textContent = '';
    const connectable = bridgeable.filter((s) => isLocal(s) || supportsWebrtc(s));
    if (connectable.length === 0) {
      const warn = document.createElement('div');
      warn.className = 'hint';
      warn.style.color = '#c0392b';
      warn.textContent =
        'No WebRTC-capable seller found. Legacy network sellers reset a browser ' +
        'connection. Start the local demo seller or wait for sellers to update their node.';
      sellersDiv.append(warn);
    }
    for (const seller of bridgeable) renderSeller(seller);
    status(
      `Buyer peerId: ${client.peerId}\n` +
      `${sellers.length} seller(s) found, ${bridgeable.length} reachable via the relay bridge, ` +
      `${connectable.length} WebRTC-capable.`,
    );
  } catch (err) {
    status(`Failed: ${(err as Error).message}`);
  }
};

/**
 * Updated nodes with working WebRTC natives announce transport.webrtc.v1 in
 * their DHT metadata. Legacy nodes reset a browser hello.
 */
function supportsWebrtc(seller: SellerSummary): boolean {
  const capabilities = seller.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(CONNECTION_CAPABILITY_WEBRTC_V1);
}

function renderSeller(seller: SellerSummary): void {
  const row = document.createElement('div');
  row.className = 'seller';
  const services = (seller.providers as { services?: string[] }[])
    .flatMap((provider) => provider.services ?? [])
    .slice(0, 4);
  const address = String(seller.publicAddress ?? '');
  const isLocal = address.startsWith('127.') || address.startsWith('localhost');
  const webrtc = isLocal || supportsWebrtc(seller);
  const tag = isLocal ? ' ★ LOCAL DEMO' : webrtc ? ' · WebRTC ✓' : ' · legacy node';
  const label = document.createElement('code');
  label.textContent =
    `${seller.displayName ?? 'seller'}${tag} · ${seller.peerId.slice(0, 12)}… · ${address}` +
    (services.length ? `\n${services.join(', ')}` : '');
  const connectButton = document.createElement('button');
  connectButton.textContent = webrtc ? 'Connect' : 'Connect (legacy — will reset)';
  if (!webrtc) connectButton.disabled = true;
  connectButton.onclick = async () => {
    try {
      connectButton.disabled = true;
      debugLines.length = 0;
      status(`Connecting to ${seller.peerId.slice(0, 12)}…`);
      // Passing the full seller record gives the payment stack the announced
      // pricing/capability metadata for cost validation on 402 negotiation.
      session = await client!.connect(seller.peerId, seller as unknown as Partial<BuyerPeerView>);
      sendButton.disabled = false;
      outputDiv.textContent = 'Connected. Send a request.';
    } catch (err) {
      status(`Connect failed: ${(err as Error).message}`);
      debug(`connect failed: ${(err as Error).message}`);
    } finally {
      connectButton.disabled = false;
    }
  };
  row.append(label, connectButton);
  sellersDiv.append(row);
}

sendButton.onclick = async () => {
  if (!session) return;
  sendButton.disabled = true;
  outputDiv.textContent = '';
  const decoder = new TextDecoder();
  let sseBuffer = '';

  // The stream arrives as raw SSE bytes; surface assistant delta text and
  // fall back to the raw event for anything unrecognized (e.g. errors).
  const renderSse = (text: string): void => {
    sseBuffer += text;
    const events = sseBuffer.split('\n\n');
    sseBuffer = events.pop() ?? '';
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as {
            choices?: { delta?: { content?: string }; message?: { content?: string } }[];
          };
          const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
          outputDiv.textContent += delta ?? '';
        } catch {
          outputDiv.textContent += `${data}\n`;
        }
      }
    }
  };

  try {
    const provider = providerInput.value.trim();
    const response = await session.request(
      {
        path: '/v1/chat/completions',
        ...(provider ? { provider } : {}),
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({
          model: modelInput.value.trim(),
          stream: true,
          messages: [{ role: 'user', content: promptInput.value }],
        }),
      },
      { onChunk: (data, done) => renderSse(decoder.decode(data, { stream: !done })) },
    );
    if (response.status >= 400) {
      outputDiv.textContent = `HTTP ${response.status}: ${decoder.decode(response.body)}`;
    } else if (!outputDiv.textContent) {
      outputDiv.textContent = decoder.decode(response.body);
    }
  } catch (err) {
    outputDiv.textContent = `Request failed: ${(err as Error).message}`;
  } finally {
    sendButton.disabled = false;
  }
};
