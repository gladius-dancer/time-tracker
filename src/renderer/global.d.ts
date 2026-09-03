import type { TimeTrackerApi } from '../shared/ipc';

declare global {
  interface Window {
    /** Injected by the preload script via contextBridge. */
    readonly timeTracker: TimeTrackerApi;
  }
}

export {};
