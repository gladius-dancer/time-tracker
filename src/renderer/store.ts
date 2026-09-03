import type { TickPayload } from '../shared/ipc';
import type { AppSnapshot } from '../shared/types';

type Listener = (snapshot: AppSnapshot) => void;
type TickListener = (elapsedMs: number, nextScreenshotAtEpochMs: number | null) => void;

/**
 * Renderer-side mirror of the main process state.
 *
 * The renderer never computes elapsed time by counting its own timer callbacks --
 * that would drift, and would stall outright while the window is hidden. It
 * renders whatever the main process reports, and between ticks it interpolates
 * from the session's absolute start timestamp.
 */
export class Store {
  private snapshotValue: AppSnapshot | null = null;
  private listeners = new Set<Listener>();
  private tickListeners = new Set<TickListener>();
  private localTimer: number | null = null;

  get snapshot(): AppSnapshot | null {
    return this.snapshotValue;
  }

  setSnapshot(snapshot: AppSnapshot): void {
    this.snapshotValue = snapshot;
    for (const listener of this.listeners) listener(snapshot);
    this.syncLocalTimer();
  }

  applyTick(tick: TickPayload): void {
    if (this.snapshotValue?.active && this.snapshotValue.active.sessionId === tick.sessionId) {
      this.snapshotValue.active.elapsedMs = tick.elapsedMs;
      this.snapshotValue.active.nextScreenshotAtEpochMs = tick.nextScreenshotAtEpochMs;
    }
    for (const listener of this.tickListeners) {
      listener(tick.elapsedMs, tick.nextScreenshotAtEpochMs);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.snapshotValue) listener(this.snapshotValue);
    return () => this.listeners.delete(listener);
  }

  subscribeTick(listener: TickListener): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  /**
   * A local 1s interval keeps the counter smooth between main-process ticks and
   * covers the case where a tick is coalesced away. It derives its value from the
   * session start timestamp, so it can never disagree with the main process by
   * more than the rounding of a single second.
   */
  private syncLocalTimer(): void {
    const active = this.snapshotValue?.active ?? null;
    if (active && this.localTimer === null) {
      this.localTimer = window.setInterval(() => {
        const current = this.snapshotValue?.active;
        if (!current) return;
        const elapsedMs = Math.max(0, Date.now() - current.startedAtEpochMs);
        current.elapsedMs = elapsedMs;
        for (const listener of this.tickListeners) {
          listener(elapsedMs, current.nextScreenshotAtEpochMs);
        }
      }, 1_000);
    } else if (!active && this.localTimer !== null) {
      window.clearInterval(this.localTimer);
      this.localTimer = null;
    }
  }
}
