declare module "bittorrent-dht" {
  import { EventEmitter } from "node:events";

  interface DHTOptions {
    bootstrap?: string[];
    /** Ms an announced peer is kept; 0 or unset keeps it forever. */
    maxAge?: number;
  }

  class DHT extends EventEmitter {
    constructor(options?: DHTOptions);
    listen(port: number, callback?: () => void): void;
    listen(port: number, address: string, callback?: () => void): void;
    announce(infoHash: Buffer, port: number, callback?: (err?: Error) => void): void;
    lookup(infoHash: Buffer, callback?: () => void): void;
    destroy(callback?: () => void): void;
    address(): { address: string; port: number } | null;
    nodes: { toArray(): unknown[] };
    /** Pings a node without an id and adds it to the routing table once it answers. */
    addNode(node: { host: string; port: number; id?: Buffer }): void;
    toJSON(): { nodes: Array<{ host: string; port: number }> };
  }

  export default DHT;
}
