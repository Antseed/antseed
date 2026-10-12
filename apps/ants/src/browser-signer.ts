import { randomUUID } from 'node:crypto';
import { safeWalletFailure } from './wallet-errors.js';
import { AbstractSigner, getAddress, isError, resolveProperties, type Provider, type TransactionReceipt, type TransactionRequest, type TransactionResponse, type TypedDataDomain, type TypedDataField } from 'ethers';

function isTimeout(err: unknown): boolean {
  return isError(err, 'TIMEOUT') || (err instanceof Error && /timeout/i.test(err.message));
}

export interface BrowserTransaction {
  id: string;
  jobId?: string;
  from: string;
  to: string;
  data: string;
  value: string;
  chainId: number;
  submittedHash?: string;
  approvalStarted?: boolean;
}
interface Pending {
  request: BrowserTransaction;
  provider: Provider;
  nonceFloor: number;
  resolve: (tx: TransactionResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How long an unopened request waits for someone to click Approve. */
const APPROVAL_IDLE_MS = 10 * 60_000;
/** How long an opened wallet prompt may sit before the request expires. */
const APPROVAL_WINDOW_MS = 30 * 60_000;
/** One receipt poll slice; slices repeat until CONFIRMATION_MAX_MS. */
const CONFIRMATION_SLICE_MS = 180_000;
const CONFIRMATION_MAX_MS = 30 * 60_000;
const TRANSACTION_LOOKUP_ATTEMPTS = 5;
const TRANSACTION_LOOKUP_DELAY_MS = 2_000;

/** EIP-7702 delegation designator: the account's code points at a delegate contract. */
async function isDelegatedAccount(provider: Provider, address: string): Promise<boolean> {
  return (await provider.getCode(address)).toLowerCase().startsWith('0xef0100');
}

const sleep = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/** One wallet approval at a time. No private key or local transaction signer is held here. */
export class BrowserSigning {
  private pending: Pending | null = null;
  private generation = 0;
  constructor(private readonly chainId: number) {}
  get request(): BrowserTransaction | null { return this.pending?.request ?? null; }
  signer(address: string, provider: Provider): AbstractSigner {
    return new BrowserSigner(getAddress(address), provider, this, this.generation);
  }
  cancel(reason = 'Wallet or network changed. Review completed transactions before starting again.'): void {
    this.generation++;
    const pending = this.pending;
    // A broadcast transaction must still be reconciled. The old signer cannot start another step.
    if (pending && !pending.request.submittedHash && !pending.request.approvalStarted) {
      clearTimeout(pending.timer);
      this.pending = null;
      pending.reject(new Error(reason));
    }
  }
  async send(address: string, provider: Provider, generation: number, tx: TransactionRequest): Promise<TransactionResponse> {
    if (generation !== this.generation) throw new Error('The signing wallet changed. Reopen the action.');
    if (this.pending) throw new Error('Another wallet approval is pending.');
    const resolved = await resolveProperties(tx);
    if (!resolved.to || typeof resolved.to !== 'string') throw new Error('Contract creation is not supported.');
    if (resolved.from && getAddress(String(resolved.from)) !== address) throw new Error('Transaction sender does not match the connected wallet.');
    if (resolved.chainId != null && BigInt(resolved.chainId) !== BigInt(this.chainId)) throw new Error('Transaction network mismatch.');
    if ((await provider.getNetwork()).chainId !== BigInt(this.chainId)) throw new Error('RPC network mismatch.');
    const request: BrowserTransaction = { id: randomUUID(), from: address, to: getAddress(resolved.to), data: resolved.data ?? '0x', value: BigInt(resolved.value ?? 0).toString(), chainId: this.chainId };
    const nonceFloor = await provider.getTransactionCount(address, 'latest');
    // Simulate using the actual external sender before asking for approval.
    await provider.call({ from: address, to: request.to, data: request.data, value: BigInt(request.value) });
    if (generation !== this.generation) throw new Error('The signing wallet changed.');
    return new Promise((resolve, reject) => {
      this.pending = { request, provider, nonceFloor, resolve, reject, timer: this.expiry(request.id, APPROVAL_IDLE_MS) };
    });
  }
  private expiry(id: string, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const pending = this.pending;
      if (!pending || pending.request.id !== id || pending.request.submittedHash) return;
      this.pending = null;
      pending.reject(new Error(pending.request.approvalStarted
        ? 'Wallet approval expired. If you confirmed this transaction in your wallet, check it there before retrying; nothing was automatically resubmitted.'
        : 'Wallet approval expired. No transaction was automatically retried.'));
    }, ms);
    timer.unref();
    return timer;
  }
  begin(id: string): void {
    const pending = this.pending;
    const request = pending?.request;
    if (!pending || !request || request.id !== id) throw new Error('This wallet request is no longer active.');
    if (request.approvalStarted || request.submittedHash) throw new Error('This request is already being approved. Check the original wallet window.');
    request.approvalStarted = true;
    // The wallet prompt is open now; give the user the full window to act on it.
    clearTimeout(pending.timer);
    pending.timer = this.expiry(id, APPROVAL_WINDOW_MS);
  }
  async complete(id: string, hash?: string, error?: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.request.id !== id) throw new Error('This wallet request is no longer active.');
    if (pending.request.submittedHash) {
      if (pending.request.submittedHash === hash) return;
      throw new Error('A transaction has already been submitted for this request.');
    }
    if (error) {
      clearTimeout(pending.timer); this.pending = null;
      pending.reject(new Error(safeWalletFailure(error)));
      return;
    }
    if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid transaction hash.');
    pending.request.submittedHash = hash;
    clearTimeout(pending.timer);
    // Keep HTTP acknowledgment short; the job continues only after chain verification.
    void (async () => {
      try {
        const receipt = await this.awaitReceipt(pending.provider, hash);
        if (!receipt) throw new Error(`Transaction ${hash} was not confirmed within 30 minutes. It may still be pending in your wallet; check it there before retrying. Nothing was automatically resubmitted.`);
        const tx = await this.lookupTransaction(pending.provider, hash);
        const expected = pending.request;
        if (!tx) throw new Error(`Transaction ${hash} confirmed but could not be read back from the RPC endpoints. Check it in the explorer before retrying.`);
        const sameSender = tx.nonce >= pending.nonceFloor && tx.chainId === BigInt(expected.chainId) && getAddress(tx.from) === expected.from;
        const verbatim = sameSender && !!tx.to && getAddress(tx.to) === expected.to && tx.data.toLowerCase() === expected.data.toLowerCase() && tx.value === BigInt(expected.value);
        // An EIP-7702 smart account (MetaMask's delegator) routes the call through its delegation
        // framework, so the outer transaction targets that framework instead of our contract.
        // Accept it when the same account sent it and the reviewed contract emitted an event in the receipt.
        if (!verbatim && !(sameSender && await isDelegatedAccount(pending.provider, expected.from) && receipt.logs.some(log => getAddress(log.address) === expected.to))) {
          throw new Error('Submitted transaction does not match the reviewed wallet request.');
        }
        if (receipt.status !== 1) throw new Error('Transaction failed on-chain. Check the transaction before retrying.');
        pending.resolve(tx);
      } catch (err) { pending.reject(err instanceof Error ? err : new Error(String(err))); }
      finally { if (this.pending === pending) this.pending = null; }
    })();
  }
  /** ethers 6 rejects with TIMEOUT rather than resolving null; keep polling in slices while the transaction may still land. */
  private async awaitReceipt(provider: Provider, hash: string): Promise<TransactionReceipt | null> {
    const deadline = Date.now() + CONFIRMATION_MAX_MS;
    while (Date.now() < deadline) {
      try {
        const receipt = await provider.waitForTransaction(hash, 1, Math.min(CONFIRMATION_SLICE_MS, deadline - Date.now()));
        if (receipt) return receipt;
      } catch (err) {
        if (!isTimeout(err)) throw err;
      }
    }
    return null;
  }
  /** A fallback endpoint can lag the one that served the receipt; a missing transaction is retried, not treated as forged. */
  private async lookupTransaction(provider: Provider, hash: string): Promise<TransactionResponse | null> {
    for (let attempt = 1; ; attempt++) {
      const tx = await provider.getTransaction(hash);
      if (tx || attempt >= TRANSACTION_LOOKUP_ATTEMPTS) return tx;
      await sleep(TRANSACTION_LOOKUP_DELAY_MS);
    }
  }
}

class BrowserSigner extends AbstractSigner {
  constructor(private readonly address: string, provider: Provider, private readonly bridge: BrowserSigning, private readonly generation: number) { super(provider); }
  getAddress(): Promise<string> { return Promise.resolve(this.address); }
  connect(provider: Provider | null): AbstractSigner {
    if (!provider) throw new Error('Browser signing requires a provider.');
    return new BrowserSigner(this.address, provider, this.bridge, this.generation);
  }
  signTransaction(_tx: TransactionRequest): Promise<string> { return Promise.reject(new Error('Use wallet transaction approval.')); }
  signMessage(_message: string | Uint8Array): Promise<string> { return Promise.reject(new Error('Arbitrary message signing is not supported.')); }
  signTypedData(_domain: TypedDataDomain, _types: Record<string, TypedDataField[]>, _value: Record<string, unknown>): Promise<string> { return Promise.reject(new Error('Use the existing wallet authorization flow.')); }
  override sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> { return this.bridge.send(this.address, this.provider!, this.generation, tx); }
}
