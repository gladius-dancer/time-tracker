import type { ActiveApplication, SourceStatus } from '../../../../shared/types';

/**
 * A strategy for asking the OS which application is in the foreground.
 *
 * Every platform answers this question differently and none of them are exposed
 * by Electron, so detection is isolated behind this interface: the
 * `ApplicationUsageTracker` handles coalescing, attribution and persistence, and
 * knows nothing about the operating system.
 */
export interface ActiveApplicationSource {
  readonly id: string;
  readonly label: string;
  /** Cheap availability check, run once at startup and surfaced in diagnostics. */
  probe(): Promise<Omit<SourceStatus, 'id' | 'label'>>;
  /**
   * The current foreground application, or null when nothing relevant is active
   * or detection failed. Must never throw.
   */
  detect(): Promise<ActiveApplication | null>;
}
