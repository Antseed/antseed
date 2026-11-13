export interface WebLockLike {
  readonly name: string;
  readonly mode: 'exclusive' | 'shared';
}

export interface WebLockManagerLike {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: WebLockLike | null) => Promise<T> | T,
  ): Promise<T>;
}

export class BuyerAlreadyActiveError extends Error {
  readonly code = 'buyer_active_in_another_tab';

  constructor(readonly lockName: string) {
    super('This AntSeed buyer is already active in another tab');
    this.name = 'BuyerAlreadyActiveError';
  }
}

export class BuyerTabLock {
  private released = false;
  private releaseHold!: () => void;

  private constructor(
    readonly name: string,
    private readonly requestPromise: Promise<unknown>,
  ) {}

  static async acquire(
    name: string,
    manager: WebLockManagerLike,
    { wait = false }: { wait?: boolean } = {},
  ): Promise<BuyerTabLock> {
    let acquiredResolve!: () => void;
    let acquiredReject!: (error: Error) => void;
    const acquired = new Promise<void>((resolve, reject) => {
      acquiredResolve = resolve;
      acquiredReject = reject;
    });
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const requestPromise = manager.request(
      name,
      { mode: 'exclusive', ...(wait ? {} : { ifAvailable: true }) },
      async (lock) => {
        if (!lock) {
          acquiredReject(new BuyerAlreadyActiveError(name));
          return;
        }
        acquiredResolve();
        await hold;
      },
    );
    void requestPromise.catch((error: unknown) => {
      acquiredReject(error instanceof Error ? error : new Error(String(error)));
    });

    await acquired;
    const result = new BuyerTabLock(name, requestPromise);
    result.releaseHold = releaseHold;
    return result;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.releaseHold();
    await this.requestPromise;
  }
}
