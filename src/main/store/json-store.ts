import { promises as fs, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * A tiny durable JSON document store.
 *
 * Chosen over a native database (better-sqlite3 & friends) deliberately: this app
 * ships as a universal macOS / Windows / Linux build, and a native module would
 * need per-arch rebuilds for every target. The read/write surface below is narrow
 * on purpose so the storage engine can be swapped without touching the domain
 * layer -- `Repository` is the only consumer.
 *
 * Durability: writes go to a temp file which is fsync'd and then atomically
 * renamed over the real file, so a crash mid-write can never truncate the data.
 * Writes are debounced to keep the tracking loop free of disk latency, and
 * `flushSync` runs on quit so nothing in flight is lost.
 */
export class JsonStore<T extends object> {
  private data: T;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** Distinguishes concurrent temp files; see `tempPath`. */
  private writeSequence = 0;
  /** Monotonic version of the document, bumped on every mutation. */
  private version = 0;
  /** Highest version already durably written; guards against stale overwrites. */
  private writtenVersion = 0;

  constructor(
    private readonly filePath: string,
    private readonly defaults: () => T,
    private readonly debounceMs = 250,
  ) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.data = this.load();
  }

  private load(): T {
    const candidates = [this.filePath, `${this.filePath}.bak`];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        const raw = readFileSync(candidate, 'utf8');
        if (!raw.trim()) continue;
        const parsed = JSON.parse(raw) as T;
        if (parsed && typeof parsed === 'object') {
          // Merge onto defaults so a file written by an older version that lacks
          // newer top-level collections still loads cleanly.
          return { ...this.defaults(), ...parsed };
        }
      } catch (error) {
        console.error(`[store] could not read ${candidate}:`, error);
      }
    }
    return this.defaults();
  }

  /** Read-only view of the document. Mutate through `update`. */
  get state(): Readonly<T> {
    return this.data;
  }

  /** Apply a mutation and schedule a durable write. */
  update(mutate: (draft: T) => void): void {
    mutate(this.data);
    this.version += 1;
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.debounceMs);
    this.flushTimer.unref?.();
  }

  /** Force a write now. Safe to call concurrently; writes are serialised. */
  flush(): Promise<void> {
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const payload = JSON.stringify(this.data, null, 2);
    const version = this.version;
    this.writing = this.writing.then(() => this.writeAtomic(payload, version)).catch((error) => {
      console.error('[store] flush failed:', error);
    });
    return this.writing;
  }

  /** Resolves once every write started so far has finished. */
  settled(): Promise<void> {
    return this.writing;
  }

  /**
   * A unique temp path per write. A shared one would let `flushSync` rename the
   * temp file out from under an in-flight async write, which then fails with
   * ENOENT.
   */
  private tempPath(): string {
    this.writeSequence += 1;
    return `${this.filePath}.${process.pid}.${this.writeSequence}.tmp`;
  }

  private async writeAtomic(payload: string, version: number): Promise<void> {
    const tmp = this.tempPath();
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A `flushSync` (or a later async write) may have landed newer data while this
    // one was in flight. Renaming now would overwrite it with a stale snapshot.
    if (version <= this.writtenVersion) {
      await fs.unlink(tmp).catch(() => undefined);
      return;
    }

    if (existsSync(this.filePath)) {
      await fs.copyFile(this.filePath, `${this.filePath}.bak`).catch(() => undefined);
    }
    try {
      await fs.rename(tmp, this.filePath);
      this.writtenVersion = version;
    } catch (error) {
      await fs.unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  /** Synchronous last-chance write, for `before-quit`. */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const tmp = this.tempPath();
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
      // Anything still in flight is now stale and must not rename over this.
      this.writtenVersion = this.version;
    } catch (error) {
      console.error('[store] flushSync failed:', error);
    }
  }
}

export function storeFile(dir: string, name: string): string {
  return join(dir, name);
}
