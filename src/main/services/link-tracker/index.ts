import { randomUUID } from 'node:crypto';

import type { LinkSource, LinkSourceStatus, OpenedLink, TrackingSession } from '../../../shared/types';
import type { Repository } from '../../store/repository';
import { ClipboardLinkSource } from './sources/clipboard';
import { LinuxWindowLinkSource } from './sources/linux';
import { MacBrowserLinkSource } from './sources/macos';
import type { LinkTrackingSource } from './sources/types';
import { WindowsBrowserLinkSource } from './sources/windows';
import { hostOf, isIgnorable, normaliseUrl } from './url';

const POLL_INTERVAL_MS = 2_500;

export interface LinkTrackerEvents {
  onLinksRecorded(links: OpenedLink[]): void;
}

/**
 * Collects the URLs a user opens, but only while a session is running.
 *
 * Sources are composed rather than hard-coded so a platform strategy can be added
 * or removed without touching the recording, dedupe or persistence logic. Nothing
 * is polled when no session is active -- outside a tracking session this class
 * does no work at all.
 */
export class LinkTracker {
  private readonly sources: LinkTrackingSource[];
  private statuses: LinkSourceStatus[] = [];
  private timer: NodeJS.Timeout | null = null;
  private session: TrackingSession | null = null;
  private polling = false;
  private seenUrls = new Set<string>();

  constructor(
    private readonly repository: Repository,
    private readonly events: LinkTrackerEvents,
  ) {
    this.sources = [
      new ClipboardLinkSource(),
      ...(process.platform === 'darwin' ? [new MacBrowserLinkSource()] : []),
      ...(process.platform === 'win32' ? [new WindowsBrowserLinkSource()] : []),
      ...(process.platform === 'linux' ? [new LinuxWindowLinkSource()] : []),
    ];
  }

  /** Runs each source's availability probe once; results feed the diagnostics panel. */
  async probeSources(): Promise<LinkSourceStatus[]> {
    this.statuses = await Promise.all(
      this.sources.map(async (source) => {
        try {
          const result = await source.probe();
          return { id: source.id, label: source.label, ...result };
        } catch (error) {
          return {
            id: source.id,
            label: source.label,
            available: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return this.statuses;
  }

  get sourceStatuses(): LinkSourceStatus[] {
    return this.statuses;
  }

  async start(session: TrackingSession): Promise<void> {
    this.session = session;
    this.seenUrls = this.repository.linkUrlsForSession(session.id);
    await Promise.all(
      this.sources.map(async (source) => {
        try {
          await source.reset();
        } catch (error) {
          console.error(`[links] source ${source.id} failed to reset:`, error);
        }
      }),
    );

    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.session = null;
    this.seenUrls.clear();
  }

  /** Records a URL supplied out-of-band (deep link, or manual entry in Debug Mode). */
  record(url: string, title: string | null, source: LinkSource): OpenedLink | null {
    const session = this.session;
    if (!session) return null;

    const normalised = normaliseUrl(url);
    if (!normalised || isIgnorable(normalised) || this.seenUrls.has(normalised)) return null;

    const link = this.persist(session, normalised, title, source);
    this.events.onLinksRecorded([link]);
    return link;
  }

  private async poll(): Promise<void> {
    const session = this.session;
    if (!session || this.polling) return;
    this.polling = true;

    try {
      const batches = await Promise.all(
        this.sources.map(async (source) => {
          try {
            return await source.poll();
          } catch (error) {
            console.error(`[links] source ${source.id} failed:`, error);
            return [];
          }
        }),
      );

      const recorded: OpenedLink[] = [];
      for (const detected of batches.flat()) {
        // The session can end while a poll is in flight; anything detected after
        // that belongs to no session and is dropped.
        if (this.session?.id !== session.id) break;
        const url = normaliseUrl(detected.url);
        if (!url || isIgnorable(url) || this.seenUrls.has(url)) continue;
        recorded.push(this.persist(session, url, detected.title, detected.source));
      }

      if (recorded.length > 0) this.events.onLinksRecorded(recorded);
    } finally {
      this.polling = false;
    }
  }

  private persist(
    session: TrackingSession,
    url: string,
    title: string | null,
    source: LinkSource,
  ): OpenedLink {
    this.seenUrls.add(url);
    const link: OpenedLink = {
      id: randomUUID(),
      sessionId: session.id,
      taskId: session.taskId,
      taskName: session.taskName,
      url,
      host: hostOf(url),
      title,
      source,
      detectedAt: new Date().toISOString(),
    };
    this.repository.addLink(link);
    return link;
  }
}
