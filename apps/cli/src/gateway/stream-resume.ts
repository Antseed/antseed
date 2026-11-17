import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { open, readFile, rm, type FileHandle } from 'node:fs/promises'
import type * as http from 'node:http'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { errorMessage } from './errors.js'

/** How long a dropped stream keeps generating, waiting for its client's retry. */
export const STREAM_RESUME_GRACE_MS = 30_000
/** Raw bytes compressed together into one stored frame. */
const BLOCK_BYTES = 64 * 1024
/** Compressed bytes a stream keeps in memory before it moves to a file; most answers never reach it. */
const MEMORY_BYTES = 256 * 1024
/** Compressed bytes one stream may store; past it the stream is delivered as before, without resume. */
const MAX_STREAM_BYTES = 16 * 1024 * 1024
/** Compressed bytes all streams together may store. */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const FRAME_HEADER_BYTES = 4

export interface StreamResumeOptions {
  /**
   * Where streams too large for memory are written. Each gateway process
   * writes in a folder of its own below it; `prepare()` removes the folders
   * of processes that are gone.
   */
  dir: string
  graceMs?: number
  blockBytes?: number
  memoryBytes?: number
  maxStreamBytes?: number
  maxTotalBytes?: number
  onLog?: (message: string) => void
  /** This gateway's process id, which names its folder; tests set one to stand for another process. */
  pid?: number
}

/** What the gateway can pause and resume: the buyer's response. */
export interface StreamSource {
  pause(): unknown
  resume(): unknown
}

/**
 * Identifies a retry: the same API key sending the same request again, under
 * the same requirements for what generates it (`requirements`: the effective
 * routing policy and the headers that pick a seller or shape the answer). A
 * client that loses its connection mid-stream drops what it received and
 * resends the request as it was, so its body is the same.
 */
export function streamFingerprint(keyId: string, method: string, path: string, requirements: readonly string[], body: Buffer): string {
  const hash = createHash('sha256')
  for (const part of [keyId, method, path, ...[...requirements].sort()]) hash.update(part).update('\0')
  return hash.update(body).digest('hex')
}

/**
 * Streamed answers in flight, kept so that a client whose connection drops
 * can get the whole answer by sending its request again, instead of the
 * gateway cancelling the generation and the retry paying for a new one.
 *
 * Each answer is recorded while it streams, compressed in blocks; a large
 * one moves from memory to a file. Nothing is synced to disk: a copy only
 * matters while its connection could come back. A copy is deleted as soon
 * as its answer is delivered in full, or once its client has been gone for
 * the grace period, which also cancels the generation if it is still running.
 */
export class StreamResumeStore {
  readonly graceMs: number
  readonly blockBytes: number
  readonly memoryBytes: number
  readonly maxStreamBytes: number
  private readonly _maxTotalBytes: number
  private readonly _streams = new Map<string, ResumableStream>()
  private _storedBytes = 0
  private _files = 0
  private _closing = false
  /** This process's own folder: `<pid>-<random>`, so another gateway on the same data dir never touches it. */
  private readonly _dir: string
  private readonly _pid: number

  constructor(private readonly _options: StreamResumeOptions) {
    this.graceMs = _options.graceMs ?? STREAM_RESUME_GRACE_MS
    this.blockBytes = _options.blockBytes ?? BLOCK_BYTES
    this.memoryBytes = _options.memoryBytes ?? MEMORY_BYTES
    this.maxStreamBytes = _options.maxStreamBytes ?? MAX_STREAM_BYTES
    this._maxTotalBytes = _options.maxTotalBytes ?? MAX_TOTAL_BYTES
    this._pid = _options.pid ?? process.pid
    this._dir = join(_options.dir, `${this._pid}-${randomBytes(6).toString('hex')}`)
  }

  /**
   * Creates this process's folder, and removes what gateways that are no
   * longer running left behind. A folder of a running gateway (one started
   * on the same data dir) is left alone: it holds that gateway's streams.
   */
  prepare(): void {
    mkdirSync(this._options.dir, { recursive: true, mode: 0o700 })
    for (const entry of readdirSync(this._options.dir)) {
      const pid = Number(/^(\d+)-[0-9a-f]+$/.exec(entry)?.[1] ?? NaN)
      // Our own pid on another folder is an earlier process that had it (a restarted container).
      if (Number.isInteger(pid) && pid !== this._pid && processRunning(pid)) continue
      rmSync(join(this._options.dir, entry), { recursive: true, force: true })
    }
    mkdirSync(this._dir, { mode: 0o700 })
  }

  /** Streams being kept, for tests and the log. */
  get size(): number {
    return this._streams.size
  }

  /** Compressed bytes stored across all streams. */
  get storedBytes(): number {
    return this._storedBytes
  }

  /**
   * Starts keeping a streamed answer. `abandon` cancels the generation; it is
   * called when the client stays away past the grace period. Null when the
   * same request is already streaming (two identical requests at once are
   * delivered as before, each to its own client).
   */
  start(fingerprint: string, tag: string, status: number, headers: http.OutgoingHttpHeaders, source: StreamSource, abandon: () => void): ResumableStream | null {
    if (this._closing || this._streams.has(fingerprint)) return null
    const stream = new ResumableStream(this, fingerprint, tag, status, headers, source, abandon)
    this._streams.set(fingerprint, stream)
    return stream
  }

  /** The dropped stream a retry with this fingerprint can take over, if any. */
  claim(fingerprint: string): ResumableStream | null {
    if (this._closing) return null
    const stream = this._streams.get(fingerprint)
    return stream?.claimable ? stream : null
  }

  /** True once the gateway is stopping: no retry can reach it any more. */
  get closing(): boolean {
    return this._closing
  }

  /**
   * The gateway is stopping. Streams waiting for a retry are cancelled, since
   * none can arrive; streams a client is reading carry on through the
   * shutdown drain, and a client that drops from now on cancels its stream.
   */
  close(): void {
    this._closing = true
    for (const stream of [...this._streams.values()]) {
      if (stream.waitingForRetry) stream.dispose({ abandon: true })
    }
  }

  /** Drops every copy left, cancelling what still runs, and removes this process's folder (after the shutdown drain). */
  disposeAll(): void {
    this._closing = true
    for (const stream of [...this._streams.values()]) stream.dispose({ abandon: true })
    rmSync(this._dir, { recursive: true, force: true })
  }

  /** @internal */
  reserve(bytes: number): boolean {
    if (this._storedBytes + bytes > this._maxTotalBytes) return false
    this._storedBytes += bytes
    return true
  }

  /** @internal */
  release(bytes: number): void {
    this._storedBytes = Math.max(0, this._storedBytes - bytes)
  }

  /** @internal */
  remove(stream: ResumableStream): void {
    if (this._streams.get(stream.fingerprint) === stream) this._streams.delete(stream.fingerprint)
  }

  /** @internal */
  nextFilePath(): string {
    return join(this._dir, `${++this._files}.bin`)
  }

  /** @internal */
  log(message: string): void {
    this._options.onLog?.(message)
  }
}

/** One streamed answer: delivered to its current client, and recorded for a client that comes back. */
export class ResumableStream {
  private _target: http.ServerResponse | null = null
  private _replaying = false
  private _liveQueue: Buffer[] = []
  private _sourcePaused = false
  private _ended = false
  private _recording = true
  private _disposed = false
  private _graceTimer: ReturnType<typeof setTimeout> | null = null
  // Compressed frames still in memory, and raw bytes not yet compressed.
  private _frames: Buffer[] = []
  private _pending: Buffer[] = []
  private _pendingBytes = 0
  private _storedBytes = 0
  private _file: { path: string; handle: Promise<FileHandle> } | null = null
  private _framesInFile = 0
  private _writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly _store: StreamResumeStore,
    readonly fingerprint: string,
    readonly tag: string,
    private readonly _status: number,
    private readonly _headers: http.OutgoingHttpHeaders,
    private readonly _source: StreamSource,
    private readonly _abandon: () => void,
  ) {}

  /** A dropped stream that is still recorded in full. */
  get claimable(): boolean {
    return !this._disposed && this._recording && this._target === null
  }

  /** Delivers the answer to the client that asked for it; its headers are already sent. */
  attach(res: http.ServerResponse): void {
    this._target = res
    res.once('finish', () => this._onDelivered(res))
  }

  /** One chunk of the buyer's answer. */
  append(chunk: Buffer): void {
    if (this._disposed) return
    if (this._recording) this._record(chunk)
    this._deliver(chunk)
  }

  /** The buyer's answer is complete. */
  end(): void {
    if (this._disposed || this._ended) return
    this._ended = true
    if (this._recording) this._seal()
    if (this._target && !this._replaying) this._target.end()
  }

  /**
   * The client `res` went away. True when the answer is kept for a retry: its
   * generation keeps going, or it is complete and waits to be fetched. False
   * when it cannot be kept (it outgrew the limits, storing it failed, or the
   * gateway is stopping): the copy is dropped and a generation still running
   * is cancelled, whichever client (the first or a retry) went away.
   */
  detach(res: http.ServerResponse): boolean {
    if (this._disposed) return false
    // Not the client being served (a retry already took over): the stream carries on for that one.
    if (this._target !== res) return true
    this._target = null
    this._replaying = false
    this._liveQueue = []
    if (!this._recording || this._store.closing) {
      this.dispose({ abandon: true })
      return false
    }
    // Keep generating (and recording) while nobody reads.
    this._resumeSource()
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null
      if (this._target !== null) return
      this._store.log(`gateway dropped stream not retried in time: tag=${this.tag}`)
      this.dispose({ abandon: true })
    }, this._store.graceMs)
    this._graceTimer.unref?.()
    return true
  }

  /** A retry takes over: everything recorded so far is replayed from the start, then the rest follows live. */
  resume(res: http.ServerResponse): void {
    if (this._graceTimer) clearTimeout(this._graceTimer)
    this._graceTimer = null
    this._target = res
    this._replaying = true
    // Hold the buyer back while the recorded part replays, so a slow client cannot pile the live tail up in memory.
    this._pauseSource()
    res.once('close', () => { if (!res.writableFinished) this.detach(res) })
    res.once('finish', () => this._onDelivered(res))
    res.writeHead(this._status, this._headers)
    // What was recorded up to now; chunks arriving during the replay queue behind it.
    const memoryFrames = [...this._frames]
    const pending = [...this._pending]
    const framesInFile = this._framesInFile
    const file = this._file
    const written = this._writes
    void (async () => {
      try {
        if (file && framesInFile > 0) {
          await written
          const stored = await readFile(file.path)
          let offset = 0
          for (let i = 0; i < framesInFile; i++) {
            const length = stored.readUInt32BE(offset)
            const frame = stored.subarray(offset + FRAME_HEADER_BYTES, offset + FRAME_HEADER_BYTES + length)
            offset += FRAME_HEADER_BYTES + length
            if (!await writeTo(res, inflateRawSync(frame))) return
          }
        }
        for (const frame of memoryFrames) {
          if (!await writeTo(res, inflateRawSync(frame))) return
        }
        for (const chunk of pending) {
          if (!await writeTo(res, chunk)) return
        }
        // The live tail: drain what queued during the replay, then deliver directly.
        while (this._target === res && this._liveQueue.length > 0) {
          const queued = this._liveQueue
          this._liveQueue = []
          for (const chunk of queued) {
            if (!await writeTo(res, chunk)) return
          }
        }
        if (this._target !== res) return
        this._replaying = false
        this._resumeSource()
        if (this._ended) res.end()
      } catch (error) {
        this._store.log(`gateway could not replay stream ${this.tag}: ${errorMessage(error)}`)
        res.destroy()
      }
    })()
  }

  /** Waiting for its client's retry: the client dropped and the answer is still kept. */
  get waitingForRetry(): boolean {
    return this.claimable
  }

  /** The buyer's answer broke off: end the client being served, and drop the copy. */
  fail(): void {
    const target = this._target
    this._target = null
    this.dispose()
    target?.destroy()
  }

  /** Deletes the copy; with `abandon`, a generation still running is cancelled too. */
  dispose(options: { abandon?: boolean } = {}): void {
    if (this._disposed) return
    this._disposed = true
    if (this._graceTimer) clearTimeout(this._graceTimer)
    this._graceTimer = null
    this._dropRecording()
    this._store.remove(this)
    if (options.abandon && !this._ended) this._abandon()
  }

  private _onDelivered(res: http.ServerResponse): void {
    // Delivered in full: the copy is no longer needed.
    if (this._target === res && this._ended) this.dispose()
  }

  private _deliver(chunk: Buffer): void {
    const target = this._target
    if (!target) return
    if (this._replaying) {
      this._liveQueue.push(chunk)
      return
    }
    if (target.write(chunk) || this._sourcePaused) return
    // The client reads slower than the buyer answers: hold the buyer back, as a pipe would.
    this._pauseSource()
    target.once('drain', () => { if (this._target === target && !this._replaying) this._resumeSource() })
  }

  private _pauseSource(): void {
    if (this._sourcePaused) return
    this._sourcePaused = true
    this._source.pause()
  }

  private _resumeSource(): void {
    if (!this._sourcePaused) return
    this._sourcePaused = false
    this._source.resume()
  }

  private _record(chunk: Buffer): void {
    this._pending.push(chunk)
    this._pendingBytes += chunk.length
    if (this._pendingBytes >= this._store.blockBytes) this._seal()
  }

  /** Compresses the raw bytes not yet stored into one frame. */
  private _seal(): void {
    if (this._pending.length === 0) return
    const frame = deflateRawSync(Buffer.concat(this._pending))
    this._pending = []
    this._pendingBytes = 0
    if (this._storedBytes + frame.length > this._store.maxStreamBytes || !this._store.reserve(frame.length)) {
      this._store.log(`gateway stream too large to keep for a retry: tag=${this.tag}`)
      this._stopRecording()
      return
    }
    this._storedBytes += frame.length
    if (this._file) {
      this._writeFrame(frame)
      return
    }
    this._frames.push(frame)
    if (this._storedBytes > this._store.memoryBytes) this._spill()
  }

  /** Moves the frames in memory to a file, which takes every later frame too. */
  private _spill(): void {
    const path = this._store.nextFilePath()
    this._file = { path, handle: open(path, 'w', 0o600) }
    this._file.handle.catch(() => {})
    const frames = this._frames
    this._frames = []
    for (const frame of frames) this._writeFrame(frame)
  }

  private _writeFrame(frame: Buffer): void {
    const file = this._file!
    const header = Buffer.alloc(FRAME_HEADER_BYTES)
    header.writeUInt32BE(frame.length)
    this._framesInFile++
    // In order, batched by the OS; never synced, since the copy only matters while the process runs.
    this._writes = this._writes
      .then(async () => {
        const handle = await file.handle
        await handle.write(Buffer.concat([header, frame]))
      })
      .catch((error: unknown) => {
        if (this._disposed || this._file !== file) return
        this._store.log(`gateway could not store stream ${this.tag}: ${errorMessage(error)}`)
        this._stopRecording()
      })
  }

  /** Stops keeping the answer; it is still delivered to a client that is reading it. */
  private _stopRecording(): void {
    if (!this._recording) return
    this._recording = false
    this._dropRecording()
    if (this._target === null) this.dispose({ abandon: true })
  }

  private _dropRecording(): void {
    this._store.release(this._storedBytes)
    this._storedBytes = 0
    this._frames = []
    this._pending = []
    this._pendingBytes = 0
    const file = this._file
    this._file = null
    this._framesInFile = 0
    if (file) {
      void this._writes
        .then(async () => {
          const handle = await file.handle
          await handle.close()
        })
        .catch(() => {})
        .finally(() => rm(file.path, { force: true }).catch(() => {}))
    }
  }
}

/** Writes `chunk`, waiting for the client to take it; false once the client is gone. */
function writeTo(res: http.ServerResponse, chunk: Buffer): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false)
  if (res.write(chunk)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      res.off('drain', onDrain)
      res.off('close', onClose)
      resolve(ok)
    }
    const onDrain = () => done(true)
    const onClose = () => done(false)
    res.once('drain', onDrain)
    res.once('close', onClose)
  })
}

/** Whether a process with this pid is running (a signal-0 probe; EPERM means it runs as another user). */
function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
