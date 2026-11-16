import type { RewardTransactionRecorder } from '@antseed/node/payments';

export class RewardClaimProgress {
  claimed = 0n;
  transactions: string[] = [];

  constructor(
    private readonly report: (hash: string, kind: 'claim' | 'accounting') => void,
    private readonly received: (hash: string) => Promise<bigint>,
  ) {}

  record: RewardTransactionRecorder = async (hash, kind) => {
    this.transactions.push(hash);
    this.report(hash, kind);
    if (kind === 'claim') this.claimed += await this.received(hash);
  };

  failure(message: string): string {
    if (this.transactions.length === 0) return `Claim failed: ${message}`;
    return `Claim incomplete: ${this.transactions.length} transaction(s) already confirmed (shown above). ${message}. Re-run the claim to collect remaining rewards.`;
  }
}
