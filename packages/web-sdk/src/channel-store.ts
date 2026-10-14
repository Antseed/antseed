import type {
  BuyerChannelStore,
  ChannelKind,
  ChannelRole,
  ChannelStatus,
  StoredChannel,
} from '@antseed/buyer-core/channel-store-types';
import { CHANNEL_KIND, CHANNEL_STATUS } from '@antseed/buyer-core/channel-store-types';
import type { SpendingAuthMetadata, SpendingAuthServiceMetadata } from '@antseed/protocol/signatures';

export class MemoryChannelStore implements BuyerChannelStore {
  protected channels = new Map<string, StoredChannel>();
  protected serviceTotals = new Map<string, SpendingAuthServiceMetadata[]>();

  upsertChannel(channel: StoredChannel): void {
    this.channels.set(channel.sessionId, cloneChannel(channel));
  }

  getChannel(sessionId: string): StoredChannel | null {
    const channel = this.channels.get(sessionId);
    return channel ? cloneChannel(channel) : null;
  }

  getActiveChannelByPeerAndBuyer(
    peerId: string,
    role: ChannelRole,
    buyerEvmAddr: string,
    channelKind: ChannelKind = CHANNEL_KIND.PAID,
  ): StoredChannel | null {
    return this.latestMatching(
      (c) =>
        c.peerId === peerId &&
        c.role === role &&
        sameAddress(c.buyerEvmAddr, buyerEvmAddr) &&
        (c.channelKind ?? CHANNEL_KIND.PAID) === channelKind &&
        c.status === CHANNEL_STATUS.ACTIVE,
    );
  }

  getLatestChannelByPeerAndBuyer(
    peerId: string,
    role: ChannelRole,
    buyerEvmAddr: string,
    channelKind: ChannelKind = CHANNEL_KIND.PAID,
  ): StoredChannel | null {
    return this.latestMatching(
      (c) =>
        c.peerId === peerId &&
        c.role === role &&
        sameAddress(c.buyerEvmAddr, buyerEvmAddr) &&
        (c.channelKind ?? CHANNEL_KIND.PAID) === channelKind,
    );
  }

  getActiveChannelsByBuyer(
    role: ChannelRole,
    buyerEvmAddr: string,
    channelKind: ChannelKind = CHANNEL_KIND.PAID,
  ): StoredChannel[] {
    return [...this.channels.values()]
      .filter(
        (c) =>
          c.role === role &&
          sameAddress(c.buyerEvmAddr, buyerEvmAddr) &&
          (c.channelKind ?? CHANNEL_KIND.PAID) === channelKind &&
          c.status === CHANNEL_STATUS.ACTIVE,
      )
      .map(cloneChannel);
  }

  getOneOffChannelByRequest(peerId: string, role: ChannelRole, requestId: string): StoredChannel | null {
    return this.latestMatching(
      (c) =>
        c.peerId === peerId &&
        c.role === role &&
        c.channelKind === CHANNEL_KIND.ONE_OFF &&
        c.oneOffRequestId === requestId,
    );
  }

  updateChannelStatus(sessionId: string, status: ChannelStatus, settledAmount?: string): void {
    const channel = this.channels.get(sessionId);
    if (!channel) return;
    this.channels.set(sessionId, {
      ...channel,
      status,
      settledAmount: settledAmount ?? channel.settledAmount,
      settledAt: status === CHANNEL_STATUS.SETTLED ? Date.now() : channel.settledAt,
      updatedAt: Date.now(),
    });
  }

  replaceMetadataServiceTotals(
    sessionId: string,
    services: readonly SpendingAuthServiceMetadata[] = [],
  ): void {
    this.serviceTotals.set(sessionId, services.map(cloneService));
  }

  getChannelMetadata(channel: StoredChannel): SpendingAuthMetadata {
    const services = (this.serviceTotals.get(channel.sessionId) ?? []).map(cloneService);
    return {
      cumulativeInputTokens: BigInt(channel.tokensDelivered),
      cumulativeOutputTokens: BigInt(channel.previousConsumption),
      cumulativeRequestCount: BigInt(channel.requestCount),
      // StoredChannel has no top-level image column, so recover it from the
      // per-service totals just like the SQLite channel store.
      cumulativeOutputImages: services.reduce(
        (sum, service) => sum + (service.cumulativeOutputImages ?? 0n),
        0n,
      ),
      cumulativeVideoGenerations: services.reduce(
        (sum, service) => sum + (service.cumulativeVideoGenerations ?? 0n),
        0n,
      ),
      cumulativeVideoSeconds: services.reduce(
        (sum, service) => sum + (service.cumulativeVideoSeconds ?? 0n),
        0n,
      ),
      services,
    };
  }

  commitAuthorization(
    channel: StoredChannel,
    services: readonly SpendingAuthServiceMetadata[] = [],
  ): void {
    this.upsertChannel(channel);
    this.replaceMetadataServiceTotals(channel.sessionId, services);
  }

  async flush(): Promise<void> {}

  protected latestMatching(predicate: (channel: StoredChannel) => boolean): StoredChannel | null {
    let latest: StoredChannel | null = null;
    for (const channel of this.channels.values()) {
      if (!predicate(channel)) continue;
      if (!latest || channel.createdAt > latest.createdAt) latest = channel;
    }
    return latest ? cloneChannel(latest) : null;
  }
}

export interface IndexedDbChannelStoreOptions {
  databaseName: string;
  indexedDB?: IDBFactory;
  /** Called asynchronously as soon as a queued IndexedDB write fails. */
  onWriteError?: (error: Error) => void;
}

interface StoredServiceTotalRecord {
  sessionId: string;
  serviceId: string;
  cumulativeAmount: string;
  cumulativeInputTokens: string;
  cumulativeCachedInputTokens: string;
  cumulativeOutputTokens: string;
  cumulativeRequestCount: string;
  cumulativeOutputImages?: string;
  cumulativeVideoGenerations?: string;
  cumulativeVideoSeconds?: string;
}

const DATABASE_VERSION = 1;
const CHANNELS_STORE = 'channels';
const SERVICE_TOTALS_STORE = 'serviceTotals';
const SESSION_ID_INDEX = 'sessionId';

/**
 * IndexedDB-backed store with a synchronous in-memory read model. Call
 * `open()` before constructing BuyerPaymentManager so its hydration pass sees
 * all committed channels. Writes are serialized, and authorization commits
 * update the channel and service totals in one IndexedDB transaction.
 */
export class IndexedDbChannelStore extends MemoryChannelStore {
  private writeTail: Promise<void> = Promise.resolve();
  private fatalWriteError: unknown = null;
  private closed = false;

  private constructor(
    private readonly db: IDBDatabase,
    private readonly onWriteError?: (error: Error) => void,
  ) {
    super();
  }

  static async open(options: IndexedDbChannelStoreOptions): Promise<IndexedDbChannelStore> {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error('IndexedDB unavailable');
    const db = await openDatabase(factory, options.databaseName);
    const store = new IndexedDbChannelStore(db, options.onWriteError);
    await store.hydrate();
    return store;
  }

  override upsertChannel(channel: StoredChannel): void {
    this.assertWritable();
    const copy = cloneChannel(channel);
    super.upsertChannel(copy);
    this.enqueuePutChannel(copy);
  }

  override updateChannelStatus(sessionId: string, status: ChannelStatus, settledAmount?: string): void {
    this.assertWritable();
    super.updateChannelStatus(sessionId, status, settledAmount);
    const channel = this.channels.get(sessionId);
    if (!channel) return;
    this.enqueuePutChannel(cloneChannel(channel));
  }

  override replaceMetadataServiceTotals(
    sessionId: string,
    services: readonly SpendingAuthServiceMetadata[] = [],
  ): void {
    this.assertWritable();
    const copies = services.map(cloneService);
    super.replaceMetadataServiceTotals(sessionId, copies);
    this.enqueue(() => this.replaceServiceRecords(sessionId, copies));
  }

  override async commitAuthorization(
    channel: StoredChannel,
    services: readonly SpendingAuthServiceMetadata[] = [],
  ): Promise<void> {
    this.assertWritable();
    const channelCopy = cloneChannel(channel);
    const serviceCopies = services.map(cloneService);
    super.upsertChannel(channelCopy);
    super.replaceMetadataServiceTotals(channelCopy.sessionId, serviceCopies);

    this.enqueue(async () => {
      const tx = this.db.transaction([CHANNELS_STORE, SERVICE_TOTALS_STORE], 'readwrite');
      const done = transactionDone(tx);
      tx.objectStore(CHANNELS_STORE).put(channelCopy);
      await replaceServiceRecordsInTransaction(tx, channelCopy.sessionId, serviceCopies);
      await done;
    });
    await this.flush();
  }

  override async flush(): Promise<void> {
    await this.writeTail;
    if (this.fatalWriteError) {
      throw new Error('IndexedDB channel persistence failed', { cause: this.fatalWriteError });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    this.db.close();
  }

  private async hydrate(): Promise<void> {
    const tx = this.db.transaction([CHANNELS_STORE, SERVICE_TOTALS_STORE], 'readonly');
    const done = transactionDone(tx);
    const channelsRequest = requestResult<StoredChannel[]>(tx.objectStore(CHANNELS_STORE).getAll());
    const totalsRequest = requestResult<StoredServiceTotalRecord[]>(
      tx.objectStore(SERVICE_TOTALS_STORE).getAll(),
    );
    const [channels, totals] = await Promise.all([channelsRequest, totalsRequest]);
    await done;

    for (const channel of channels) {
      super.upsertChannel(channel);
    }
    const grouped = new Map<string, SpendingAuthServiceMetadata[]>();
    for (const record of totals) {
      const services = grouped.get(record.sessionId) ?? [];
      services.push(serviceFromRecord(record));
      grouped.set(record.sessionId, services);
    }
    for (const [sessionId, services] of grouped) {
      super.replaceMetadataServiceTotals(sessionId, services);
    }
  }

  private replaceServiceRecords(
    sessionId: string,
    services: readonly SpendingAuthServiceMetadata[],
  ): Promise<void> {
    const tx = this.db.transaction(SERVICE_TOTALS_STORE, 'readwrite');
    const done = transactionDone(tx);
    return replaceServiceRecordsInTransaction(tx, sessionId, services)
      .then(() => done);
  }

  private enqueuePutChannel(copy: StoredChannel): void {
    this.enqueue(async () => {
      const tx = this.db.transaction(CHANNELS_STORE, 'readwrite');
      const done = transactionDone(tx);
      tx.objectStore(CHANNELS_STORE).put(copy);
      await done;
    });
  }

  private enqueue(operation: () => Promise<void>): void {
    this.writeTail = this.writeTail
      .then(() => {
        if (this.fatalWriteError) throw this.fatalWriteError;
        return operation();
      })
      .catch((error: unknown) => {
        if (this.fatalWriteError) return;
        this.fatalWriteError = error;
        try {
          this.onWriteError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        } catch {
          // Persistence observers are diagnostic only.
        }
      });
  }

  private assertWritable(): void {
    if (this.closed) throw new Error('IndexedDB channel store is closed');
    if (this.fatalWriteError) {
      throw new Error('IndexedDB channel persistence failed', { cause: this.fatalWriteError });
    }
  }
}

function cloneChannel(channel: StoredChannel): StoredChannel {
  return { ...channel };
}

function cloneService(service: SpendingAuthServiceMetadata): SpendingAuthServiceMetadata {
  return { ...service };
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function serviceToRecord(
  sessionId: string,
  service: SpendingAuthServiceMetadata,
): StoredServiceTotalRecord {
  return {
    sessionId,
    serviceId: service.serviceId,
    cumulativeAmount: service.cumulativeAmount.toString(),
    cumulativeInputTokens: service.cumulativeInputTokens.toString(),
    cumulativeCachedInputTokens: service.cumulativeCachedInputTokens.toString(),
    cumulativeOutputTokens: service.cumulativeOutputTokens.toString(),
    cumulativeRequestCount: service.cumulativeRequestCount.toString(),
    cumulativeOutputImages: (service.cumulativeOutputImages ?? 0n).toString(),
    cumulativeVideoGenerations: (service.cumulativeVideoGenerations ?? 0n).toString(),
    cumulativeVideoSeconds: (service.cumulativeVideoSeconds ?? 0n).toString(),
  };
}

function serviceFromRecord(record: StoredServiceTotalRecord): SpendingAuthServiceMetadata {
  return {
    serviceId: record.serviceId,
    cumulativeAmount: BigInt(record.cumulativeAmount),
    cumulativeInputTokens: BigInt(record.cumulativeInputTokens),
    cumulativeCachedInputTokens: BigInt(record.cumulativeCachedInputTokens),
    cumulativeOutputTokens: BigInt(record.cumulativeOutputTokens),
    cumulativeRequestCount: BigInt(record.cumulativeRequestCount),
    cumulativeOutputImages: BigInt(record.cumulativeOutputImages ?? '0'),
    cumulativeVideoGenerations: BigInt(record.cumulativeVideoGenerations ?? '0'),
    cumulativeVideoSeconds: BigInt(record.cumulativeVideoSeconds ?? '0'),
  };
}

async function replaceServiceRecordsInTransaction(
  tx: IDBTransaction,
  sessionId: string,
  services: readonly SpendingAuthServiceMetadata[],
): Promise<void> {
  const store = tx.objectStore(SERVICE_TOTALS_STORE);
  const keys = await requestResult<IDBValidKey[]>(store.index(SESSION_ID_INDEX).getAllKeys(sessionId));
  for (const key of keys) store.delete(key);
  for (const service of services) store.put(serviceToRecord(sessionId, service));
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHANNELS_STORE)) {
        db.createObjectStore(CHANNELS_STORE, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(SERVICE_TOTALS_STORE)) {
        const totals = db.createObjectStore(SERVICE_TOTALS_STORE, {
          keyPath: ['sessionId', 'serviceId'],
        });
        totals.createIndex(SESSION_ID_INDEX, 'sessionId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed to open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}
