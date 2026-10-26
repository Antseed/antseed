export type StakingPage = 'stake' | 'rewards';

/** `pool` opens that seller's pool (its agent id) on the stake page. */
export function stakingLaunchUrl(url: string, page: StakingPage = 'stake', pool?: number): string {
  const target = new URL(url);
  const params = new URLSearchParams(target.hash.slice(1));
  params.set('page', page);
  if (page === 'stake' && pool !== undefined) params.set('pool', String(pool));
  target.hash = params.toString();
  return target.toString();
}

export interface StakingSession {
  readonly busy: boolean;
  pauseWrites(): void;
  open(page?: StakingPage, pool?: number): Promise<void>;
  copyLink(page?: StakingPage, pool?: number): Promise<void>;
  close(): Promise<void>;
}

/** Serialize launch/config/identity operations so a slow launch cannot retain an old signer. */
export class StakingSessionManager {
  private session: StakingSession | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private stopping = false;

  constructor(private readonly create: () => Promise<StakingSession>) {}

  get busy(): boolean { return this.session?.busy ?? false; }

  pauseWrites(): void { this.session?.pauseWrites(); }

  private run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  open(page?: StakingPage, pool?: number): Promise<void> {
    return this.withSession((session) => session.open(page, pool));
  }

  copyLink(page?: StakingPage, pool?: number): Promise<void> {
    return this.withSession((session) => session.copyLink(page, pool));
  }

  private withSession(action: (session: StakingSession) => Promise<void>): Promise<void> {
    return this.run(async () => {
      if (this.stopping) throw new Error('VPR is shutting down.');
      if (!this.session) {
        const session = await this.create();
        if (this.stopping) {
          await session.close();
          throw new Error('VPR is shutting down.');
        }
        this.session = session;
      }
      await action(this.session);
    });
  }

  reset<T>(change: () => Promise<T>): Promise<T> {
    return this.run(async () => {
      if (this.stopping) throw new Error('VPR is shutting down.');
      this.session?.pauseWrites();
      if (this.session) await this.session.close();
      this.session = null;
      return change();
    });
  }

  stop(): Promise<void> {
    this.stopping = true;
    return this.run(async () => {
      if (this.session) await this.session.close();
      this.session = null;
    });
  }
}
