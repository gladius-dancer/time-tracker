import type { LinkSource } from '../../../../shared/types';

export interface DetectedLink {
  url: string;
  title: string | null;
  source: LinkSource;
}

export interface SourceAvailability {
  available: boolean;
  /** Shown in the Debug Mode diagnostics panel. */
  detail: string;
}

/**
 * A strategy for observing URLs the user opens.
 *
 * There is no cross-platform OS API for "links the user opened", so detection is
 * necessarily best-effort and platform specific. Each source reports its own
 * availability so the UI can tell the user exactly what is and is not working
 * instead of silently recording nothing.
 */
export interface LinkTrackingSource {
  readonly id: string;
  readonly label: string;
  /** Cheap check, run once at startup and surfaced in diagnostics. */
  probe(): Promise<SourceAvailability>;
  /** Called on every poll while a session is active. Must never throw. */
  poll(): Promise<DetectedLink[]>;
  /** Reset per-source memory between sessions. May be async. */
  reset(): void | Promise<void>;
}
