declare module '*/scripts/deployments/runtime/anvil.mjs' {
  export function withAnvilFork(
    options: { forkUrl: string; forkBlockNumber?: number; chainId: number; timestamp?: number; port?: number; keepAlive?: boolean },
    body: (fork: { rpcUrl: string; child: import('node:child_process').ChildProcess }) => Promise<unknown>,
  ): Promise<unknown>;
  export function advanceTimeTo(rpcUrl: string, timestamp: number): void;
}
