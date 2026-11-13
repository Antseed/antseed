export class IndexerSyncingError extends Error {
  constructor(message = 'Waiting for Antscan to catch up with your transaction') {
    super(message);
    this.name = 'IndexerSyncingError';
  }
}
