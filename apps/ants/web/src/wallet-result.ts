type WalletResult = { id: string } & ({ hash: string } | { error: string });

export class WalletResultDelivery {
  private readonly results = new Map<string, WalletResult>();
  private readonly delivering = new Set<string>();

  constructor(private readonly send: (result: WalletResult) => Promise<unknown>) {}

  enqueue(result: WalletResult): void {
    if (!this.results.has(result.id)) this.results.set(result.id, result);
  }

  async deliver(activeId: string | null): Promise<void> {
    if (!activeId || this.delivering.has(activeId)) return;
    const result = this.results.get(activeId);
    if (!result) return;
    this.delivering.add(activeId);
    try {
      await this.send(result);
      this.results.delete(activeId);
    } catch {
      return;
    } finally {
      this.delivering.delete(activeId);
    }
  }
}
