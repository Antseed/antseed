import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { METADATA_VERSION_HEADER, type PeerMetadata } from './peer-metadata.js';

export interface MetadataServerConfig {
  port: number;
  host?: string;
  /** `requestedVersion` comes from the metadata version request header. */
  getMetadata: (requestedVersion?: number) => PeerMetadata | null;
}

/** @deprecated Standalone MetadataServer is unused; ConnectionManager._serveHttpMetadata is preferred. */
export class MetadataServer {
  private readonly _config: MetadataServerConfig;
  private _server: Server | null = null;

  constructor(config: MetadataServerConfig) {
    this._config = config;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
          return;
        }

        if (req.url !== '/metadata') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }

        const header = req.headers[METADATA_VERSION_HEADER];
        const requested = typeof header === 'string' && /^\d{1,4}$/.test(header.trim()) ? Number(header.trim()) : undefined;
        const metadata = this._config.getMetadata(requested);
        if (!metadata) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'metadata not available' }));
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(metadata));
      });

      this._server.on('error', reject);
      this._server.listen(this._config.port, this._config.host ?? '0.0.0.0', () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this._server) {
        resolve();
        return;
      }
      this._server.close(() => {
        this._server = null;
        resolve();
      });
    });
  }

  getPort(): number {
    if (!this._server) return this._config.port;
    const addr = this._server.address();
    if (addr && typeof addr !== 'string') {
      return addr.port;
    }
    return this._config.port;
  }
}
