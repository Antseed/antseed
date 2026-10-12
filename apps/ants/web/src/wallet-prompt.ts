import type { BrowserTransaction } from '../../src/browser-signer';

interface PromptContext {
  transaction: BrowserTransaction | null;
  locallyStartedJobIds: ReadonlySet<string>;
  accountAddress?: string;
  accountChainId?: number;
  walletAddress?: string;
  walletChainId?: number;
  expectedChainId: number;
  busy: boolean;
  settling: boolean;
}

export class WalletPromptGate {
  private readonly attempted = new Set<string>();

  canPrompt(context: PromptContext): boolean {
    const transaction = context.transaction;
    return !!transaction?.jobId
      && context.locallyStartedJobIds.has(transaction.jobId)
      && !context.busy && !context.settling
      && !transaction.approvalStarted && !transaction.submittedHash
      && !this.attempted.has(transaction.id)
      && context.accountAddress?.toLowerCase() === transaction.from.toLowerCase()
      && context.walletAddress?.toLowerCase() === transaction.from.toLowerCase()
      && context.expectedChainId === transaction.chainId
      && context.accountChainId === transaction.chainId
      && context.walletChainId === transaction.chainId;
  }

  claim(context: PromptContext): boolean {
    if (!this.canPrompt(context)) return false;
    this.attempted.add(context.transaction!.id);
    return true;
  }
}
