declare module "bittorrent-dht" {
  import { EventEmitter } from "node:events";

  interface DHTOptions {
    bootstrap?: string[];
  }

  class DHT extends EventEmitter {
    constructor(options?: DHTOptions);
    addNode(node: { host: string; port: number }): void;
    listen(port: number, callback?: () => void): void;
    announce(infoHash: Buffer, port: number, callback?: (err?: Error) => void): void;
    lookup(infoHash: Buffer, callback?: () => void): void;
    destroy(callback?: () => void): void;
    address(): { port: number } | null;
    nodes: { toArray(): unknown[] };
  }

  export default DHT;
}
