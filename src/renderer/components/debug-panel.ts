import type {
  AppSnapshot,
  AppUsagePeriod,
  AppUsageSummary,
  DebugData,
  OpenedLink,
  Screenshot,
  ScreenshotEvent,
  SessionActivity,
} from '../../shared/types';
import { clear, el, emptyState } from '../dom';
import { formatBytes, formatCompact, formatDateTime, formatTime } from '../format';
import type { Store } from '../store';

type Tab = 'screenshots' | 'links' | 'apps' | 'diagnostics';

/** How the Applications Used section rolls its data up. */
type AppGrouping = 'task' | 'session' | 'application';

/**
 * Debug Mode surface: screenshots, detected links and capture diagnostics.
 *
 * Kept entirely separate from the tracking UI -- when Debug Mode is off this
 * component renders nothing at all and does not even request the data, so normal
 * usage never pays for it and no captured imagery reaches the window.
 */
export class DebugPanel {
  private tab: Tab = 'screenshots';
  private appGrouping: AppGrouping = 'task';
  private data: DebugData | null = null;
  private loading = false;
  private visible = false;
  /** Screenshot ids already turned into data URLs, so images load once. */
  private thumbnails = new Map<string, string>();
  private expandedSessions = new Set<string>();

  constructor(
    private readonly root: HTMLElement,
    private readonly store: Store,
  ) {
    this.store.subscribe((snapshot) => this.onSnapshot(snapshot));
    window.timeTracker.onActivityChanged(() => {
      if (this.visible) void this.refresh();
    });
  }

  private onSnapshot(snapshot: AppSnapshot): void {
    const shouldShow = snapshot.settings.debugMode;
    const becameVisible = shouldShow && !this.visible;
    this.visible = shouldShow;

    if (!shouldShow) {
      this.data = null;
      this.thumbnails.clear();
      clear(this.root);
      return;
    }
    if (becameVisible || this.data === null) {
      void this.refresh();
    } else {
      this.render();
    }
  }

  private async refresh(): Promise<void> {
    this.loading = this.data === null;
    if (this.loading) this.render();
    try {
      this.data = await window.timeTracker.getDebugData();
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    clear(this.root);
    if (!this.visible) return;

    const snapshot = this.store.snapshot;
    const totals = this.data
      ? `${this.data.totalScreenshots} screenshots · ${this.data.totalLinks} links · ${formatCompact(
          this.data.totalAppUsageMs,
        )} app time`
      : '';

    this.root.append(
      el('section', { class: 'debug', 'aria-label': 'Debug mode' }, [
        el('div', { class: 'debug__banner' }, [
          el('span', { class: 'debug__chip', text: 'DEBUG' }),
          el('span', {
            class: 'debug__note',
            text: 'Developer view. Captured screenshots and detected links are visible only while Debug Mode is on.',
          }),
          el('span', { class: 'debug__totals', text: totals }),
        ]),

        el('div', { class: 'tabs', role: 'tablist' }, [
          this.tabButton('screenshots', 'Screenshots'),
          this.tabButton('links', 'Opened Links'),
          this.tabButton('apps', 'Applications Used'),
          this.tabButton('diagnostics', 'Diagnostics'),
        ]),

        el('div', { class: 'debug__body' }, [
          this.loading
            ? el('div', { class: 'capture capture--busy' }, [
                el('span', { class: 'spinner', 'aria-hidden': 'true' }),
                el('span', { text: 'Loading captured activity…' }),
              ])
            : this.tab === 'diagnostics'
              ? this.renderDiagnostics(snapshot)
              : this.tab === 'apps'
                ? this.renderApplications()
                : this.renderSessions(),
        ]),
      ]),
    );
  }

  private tabButton(tab: Tab, label: string): HTMLElement {
    const button = el('button', {
      class: `tab${this.tab === tab ? ' tab--active' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': this.tab === tab ? 'true' : 'false',
      text: label,
    });
    button.addEventListener('click', () => {
      this.tab = tab;
      this.render();
    });
    return button;
  }

  /** Screenshots and links are both organised by tracking session. */
  private renderSessions(): HTMLElement {
    const sessions = this.data?.sessions ?? [];
    const relevant = sessions.filter((entry) =>
      this.tab === 'screenshots' ? entry.screenshotEvents.length > 0 : entry.links.length > 0,
    );

    if (relevant.length === 0) {
      return this.tab === 'screenshots'
        ? emptyState(
            'No screenshots yet',
            'Every connected monitor is captured once a minute while a task is being tracked.',
          )
        : emptyState(
            'No links detected yet',
            'URLs opened or copied during an active tracking session will appear here.',
          );
    }

    const container = el('div', { class: 'sessions' });
    for (const entry of relevant) container.append(this.renderSession(entry));
    return container;
  }

  private renderSession(entry: SessionActivity): HTMLElement {
    const { session } = entry;
    const isOpen = this.expandedSessions.size === 0 || this.expandedSessions.has(session.id);
    const count = this.tab === 'screenshots' ? entry.screenshots.length : entry.links.length;

    const header = el('button', { class: 'session__head', type: 'button' }, [
      el('span', { class: `session__caret${isOpen ? ' session__caret--open' : ''}`, text: '▸' }),
      el('div', { class: 'session__title' }, [
        el('strong', { text: session.taskName }),
        el('span', {
          class: 'session__meta',
          text: `${formatDateTime(session.startedAt)} · ${
            session.durationMs === null ? 'in progress' : formatCompact(session.durationMs)
          }`,
        }),
      ]),
      el('span', { class: 'session__count', text: String(count) }),
    ]);
    header.addEventListener('click', () => {
      // First interaction pins the current all-open state, then toggles this one.
      if (this.expandedSessions.size === 0) {
        for (const s of this.data?.sessions ?? []) this.expandedSessions.add(s.session.id);
      }
      if (this.expandedSessions.has(session.id)) this.expandedSessions.delete(session.id);
      else this.expandedSessions.add(session.id);
      this.render();
    });

    return el('div', { class: 'session' }, [
      header,
      isOpen
        ? el('div', { class: 'session__body' }, [
            this.tab === 'screenshots' ? this.renderCaptureEvents(entry.screenshotEvents) : this.renderLinks(entry.links),
          ])
        : null,
    ]);
  }

  /**
   * One block per capture event -- "12:35:00 — Screenshot Captured" -- with a tile
   * per monitor beneath it, so it is obvious that the images belong together.
   */
  private renderCaptureEvents(events: ScreenshotEvent[]): HTMLElement {
    const container = el('div', { class: 'captures' });
    for (const event of events) {
      const total = event.captured + event.failed;
      container.append(
        el('div', { class: 'capture-event' }, [
          el('div', { class: 'capture-event__head' }, [
            el('span', { class: 'capture-event__time', text: formatTime(event.capturedAt) }),
            el('span', { class: 'capture-event__title', text: 'Screenshot Captured' }),
            el('span', { class: 'capture-event__task', text: event.taskName }),
            el('span', {
              class: `capture-event__count${event.failed > 0 ? ' capture-event__count--partial' : ''}`,
              text:
                event.failed > 0
                  ? `${event.captured}/${total} monitors`
                  : `${total} monitor${total === 1 ? '' : 's'}`,
            }),
          ]),
          el(
            'div',
            { class: 'shots' },
            event.screenshots.map((shot) => this.renderShot(shot)),
          ),
        ]),
      );
    }
    return container;
  }

  private renderShot(shot: Screenshot): HTMLElement {
    const figure = el('figure', { class: `shot${shot.status === 'failed' ? ' shot--failed' : ''}` });

    if (shot.status === 'failed') {
      figure.append(
        el('div', { class: 'shot__failed' }, [
          el('span', { class: 'shot__failed-icon', text: '!' }),
          el('span', { class: 'shot__failed-text', text: shot.error ?? 'Capture failed' }),
        ]),
      );
    } else {
      const frame = el('div', { class: 'shot__frame' });
      const cached = this.thumbnails.get(shot.id);
      if (cached) {
        frame.append(el('img', { class: 'shot__img', src: cached, alt: `Screenshot for ${shot.taskName}` }));
      } else {
        frame.append(el('div', { class: 'shot__skeleton' }, [el('span', { class: 'spinner' })]));
        // Images are read lazily and cached; the metadata list stays cheap even
        // with hundreds of stored captures.
        void window.timeTracker.readScreenshotDataUrl(shot.id).then((dataUrl) => {
          if (!dataUrl) return;
          this.thumbnails.set(shot.id, dataUrl);
          clear(frame);
          frame.append(el('img', { class: 'shot__img', src: dataUrl, alt: `Screenshot for ${shot.taskName}` }));
        });
      }
      frame.addEventListener('click', () => void window.timeTracker.revealScreenshot(shot.id));
      frame.title = 'Reveal file on disk';
      figure.append(frame);
    }

    const native =
      shot.displayWidth && shot.displayHeight
        ? `${shot.displayWidth}×${shot.displayHeight}${shot.scaleFactor && shot.scaleFactor !== 1 ? ` @${shot.scaleFactor}x` : ''}`
        : null;

    figure.append(
      el('figcaption', { class: 'shot__caption' }, [
        el('span', { class: 'shot__monitor' }, [
          el('span', { class: 'shot__index', text: `Monitor ${shot.displayIndex}` }),
          shot.isPrimary ? el('span', { class: 'shot__primary', text: 'primary' }) : null,
        ]),
        el('span', { class: 'shot__name', text: shot.displayName, title: `Display id ${shot.displayId}` }),
        el('span', { class: 'shot__time', text: formatTime(shot.capturedAt) }),
        el('span', {
          class: 'shot__detail',
          text:
            shot.status === 'captured'
              ? `${native ?? ''}${native ? ' → ' : ''}${shot.width}×${shot.height} · ${formatBytes(shot.sizeBytes)}`
              : 'not saved',
        }),
        el('span', { class: 'shot__task', text: shot.taskName }),
      ]),
    );
    return figure;
  }

  private renderLinks(links: OpenedLink[]): HTMLElement {
    const list = el('ul', { class: 'links' });
    for (const link of links) {
      const open = el('button', { class: 'link__url', type: 'button', text: link.url, title: link.url });
      open.addEventListener('click', () => void window.timeTracker.openLinkExternally(link.url));

      list.append(
        el('li', { class: 'link' }, [
          el('span', { class: 'link__host', text: link.host || '—' }),
          el('div', { class: 'link__main' }, [
            open,
            link.title ? el('span', { class: 'link__title', text: link.title }) : null,
          ]),
          el('div', { class: 'link__meta' }, [
            el('span', { class: 'link__task', text: link.taskName }),
            el('span', { class: 'link__time', text: formatTime(link.detectedAt) }),
            el('span', { class: `link__source link__source--${link.source}`, text: link.source }),
          ]),
        ]),
      );
    }
    return list;
  }

  // -- Applications Used ---------------------------------------------------

  /**
   * The same usage data under three groupings. Each one is a roll-up of the
   * identical set of periods, so totals agree however the user slices it.
   */
  private renderApplications(): HTMLElement {
    const data = this.data;
    if (!data || data.appUsageByApp.length === 0) {
      return emptyState(
        'No application usage yet',
        'The foreground application is sampled while a task is being tracked, and appears here grouped by task, session or application.',
      );
    }

    return el('div', { class: 'apps' }, [
      el('div', { class: 'apps__head' }, [
        el('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Group applications by' }, [
          this.groupButton('task', 'By task'),
          this.groupButton('session', 'By session'),
          this.groupButton('application', 'By application'),
        ]),
        el('span', {
          class: 'apps__total',
          text: `${formatCompact(data.totalAppUsageMs)} tracked across ${data.appUsageByApp.length} app${
            data.appUsageByApp.length === 1 ? '' : 's'
          }`,
        }),
      ]),
      this.appGrouping === 'task'
        ? this.renderAppsByTask(data)
        : this.appGrouping === 'session'
          ? this.renderAppsBySession(data)
          : this.renderAppsByApplication(data),
    ]);
  }

  private groupButton(grouping: AppGrouping, label: string): HTMLElement {
    const button = el('button', {
      class: `segmented__item${this.appGrouping === grouping ? ' segmented__item--active' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': this.appGrouping === grouping ? 'true' : 'false',
      text: label,
    });
    button.addEventListener('click', () => {
      this.appGrouping = grouping;
      this.render();
    });
    return button;
  }

  private renderAppsByTask(data: DebugData): HTMLElement {
    const container = el('div', { class: 'app-groups' });
    for (const task of data.appUsageByTask) {
      container.append(
        el('div', { class: 'app-group' }, [
          el('div', { class: 'app-group__head' }, [
            el('strong', { class: 'app-group__title', text: task.taskName }),
            el('span', { class: 'app-group__total', text: formatCompact(task.totalMs) }),
          ]),
          this.appTable(task.apps, { showTasks: false }),
        ]),
      );
    }
    return container;
  }

  private renderAppsBySession(data: DebugData): HTMLElement {
    const withUsage = data.sessions.filter((entry) => entry.appUsage.length > 0);
    if (withUsage.length === 0) {
      return emptyState('No application usage in any session', 'Start tracking a task to begin recording.');
    }

    const container = el('div', { class: 'app-groups' });
    for (const entry of withUsage) {
      const total = entry.appUsage.reduce((sum, p) => sum + p.durationMs, 0);
      container.append(
        el('div', { class: 'app-group' }, [
          el('div', { class: 'app-group__head' }, [
            el('div', { class: 'app-group__titles' }, [
              el('strong', { class: 'app-group__title', text: entry.session.taskName }),
              el('span', {
                class: 'app-group__meta',
                text: `${formatDateTime(entry.session.startedAt)} · ${
                  entry.session.durationMs === null ? 'in progress' : formatCompact(entry.session.durationMs)
                }`,
              }),
            ]),
            el('span', { class: 'app-group__total', text: formatCompact(total) }),
          ]),
          this.appTable(entry.appSummaries, { showTasks: false }),
          this.periodList(entry.appUsage),
        ]),
      );
    }
    return container;
  }

  private renderAppsByApplication(data: DebugData): HTMLElement {
    return el('div', { class: 'app-groups' }, [
      el('div', { class: 'app-group' }, [this.appTable(data.appUsageByApp, { showTasks: true })]),
    ]);
  }

  /** Name, total time, session count and first/last use for a set of apps. */
  private appTable(apps: AppUsageSummary[], options: { showTasks: boolean }): HTMLElement {
    if (apps.length === 0) {
      return el('p', { class: 'app-table__empty', text: 'No application usage recorded here.' });
    }
    const max = Math.max(...apps.map((a) => a.totalMs), 1);

    const rows = apps.map((app) =>
      el('li', { class: 'app-row' }, [
        el('div', { class: 'app-row__main' }, [
          el('span', { class: 'app-row__name', text: app.appName, title: app.appId ?? app.appName }),
          app.appId ? el('span', { class: 'app-row__id', text: app.appId }) : null,
        ]),
        el('div', { class: 'app-row__bar', 'aria-hidden': 'true' }, [
          el('span', { class: 'app-row__fill', style: `width:${Math.round((app.totalMs / max) * 100)}%` }),
        ]),
        el('div', { class: 'app-row__meta' }, [
          el('span', { class: 'app-row__total', text: formatCompact(app.totalMs) }),
          el('span', {
            class: 'app-row__count',
            text: `${app.periodCount} session${app.periodCount === 1 ? '' : 's'}`,
          }),
          el('span', {
            class: 'app-row__span',
            text: `${formatTime(app.firstStartedAt)} → ${formatTime(app.lastEndedAt)}`,
          }),
          options.showTasks && app.taskNames.length > 0
            ? el('span', { class: 'app-row__tasks', text: app.taskNames.join(', '), title: app.taskNames.join(', ') })
            : null,
        ]),
      ]),
    );
    return el('ul', { class: 'app-table' }, rows);
  }

  /** The individual periods behind a session's totals. */
  private periodList(periods: AppUsagePeriod[]): HTMLElement {
    const ordered = [...periods].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return el('details', { class: 'periods' }, [
      el('summary', { class: 'periods__summary', text: `${ordered.length} usage period${ordered.length === 1 ? '' : 's'}` }),
      el(
        'ul',
        { class: 'periods__list' },
        ordered.map((period) =>
          el('li', { class: 'period' }, [
            el('span', { class: 'period__app', text: period.appName }),
            el('span', {
              class: 'period__time',
              text: `${formatTime(period.startedAt)} → ${formatTime(period.endedAt)}`,
            }),
            el('span', { class: 'period__duration', text: formatCompact(period.durationMs) }),
            el('span', { class: 'period__task', text: period.taskName }),
          ]),
        ),
      ),
    ]);
  }

  private renderDiagnostics(snapshot: AppSnapshot | null): HTMLElement {
    if (!snapshot) return emptyState('No diagnostics', 'State has not loaded yet.');
    const { diagnostics, settings } = snapshot;

    const permissionOk = diagnostics.screenPermission === 'granted';

    return el('div', { class: 'diagnostics' }, [
      el('div', { class: 'diag-group' }, [
        el('h3', { class: 'diag-group__title', text: 'Capture settings' }),
        this.toggleRow('Capture screenshots', settings.screenshotsEnabled, (value) =>
          void window.timeTracker.updateSettings({ screenshotsEnabled: value }),
        ),
        this.toggleRow('Track opened links', settings.linkTrackingEnabled, (value) =>
          void window.timeTracker.updateSettings({ linkTrackingEnabled: value }),
        ),
        this.toggleRow('Track application usage', settings.appUsageEnabled, (value) =>
          void window.timeTracker.updateSettings({ appUsageEnabled: value }),
        ),
        this.toggleRow('Screenshot notifications', settings.notificationsEnabled, (value) =>
          void window.timeTracker.updateSettings({ notificationsEnabled: value }),
        ),
        this.intervalRow(settings.screenshotIntervalMs),
      ]),

      el('div', { class: 'diag-group' }, [
        el('h3', { class: 'diag-group__title', text: 'Screen capture' }),
        this.diagRow(
          'Permission',
          diagnostics.screenPermission,
          permissionOk
            ? 'The system allows screen capture.'
            : 'Grant Screen Recording permission, then restart the app.',
          permissionOk,
        ),
      ]),

      el('div', { class: 'diag-group' }, [
        el('h3', { class: 'diag-group__title', text: 'Notifications' }),
        this.diagRow(
          'Support',
          diagnostics.notifications.supported ? 'available' : 'unsupported',
          diagnostics.notifications.supported
            ? `Raised from the main process, so they work while the window is minimised. The OS files these under “${diagnostics.notifications.identity}” — allow that entry in System Settings › Notifications.`
            : 'This system reports no notification support.',
          diagnostics.notifications.supported,
        ),
        this.diagRow(
          'Delivered',
          `${diagnostics.notifications.delivered} shown`,
          diagnostics.notifications.failed > 0
            ? `${diagnostics.notifications.failed} failed. ${diagnostics.notifications.lastError ?? ''}`
            : diagnostics.notifications.lastDeliveredAt
              ? `Last delivered at ${formatTime(diagnostics.notifications.lastDeliveredAt)}.`
              : 'Nothing delivered yet.',
          diagnostics.notifications.failed === 0,
        ),
        this.testNotificationRow(),
      ]),

      el('div', { class: 'diag-group' }, [
        el('h3', { class: 'diag-group__title', text: `Displays (${diagnostics.displays.length})` }),
        ...diagnostics.displays.map((display) =>
          this.diagRow(
            `Monitor ${display.index}${display.isPrimary ? ' (primary)' : ''}`,
            `${display.width}×${display.height}`,
            `${display.name} · scale ${display.scaleFactor}x · rotation ${display.rotation}° · at (${display.x}, ${display.y}) · id ${display.id}`,
            true,
          ),
        ),
        diagnostics.displays.length === 0
          ? this.diagRow('None detected', 'unavailable', 'No displays were reported by the system.', false)
          : null,
      ]),

      el('div', { class: 'diag-group' }, [
        el('h3', { class: 'diag-group__title', text: 'Link detection sources' }),
        ...diagnostics.linkSources.map((source) =>
          this.diagRow(source.label, source.available ? 'active' : 'unavailable', source.detail, source.available),
        ),
        this.manualLinkRow(),
      ]),

      el('div', { class: 'diag-group' }, [
        el('h3', { class: 'diag-group__title', text: 'Application detection' }),
        ...diagnostics.appUsageSources.map((source) =>
          this.diagRow(source.label, source.available ? 'active' : 'unavailable', source.detail, source.available),
        ),
        this.currentAppRow(),
      ]),

      el('div', { class: 'diag-group' }, [
        el('h3', { class: 'diag-group__title', text: 'Storage' }),
        this.diagRow('Platform', diagnostics.platform, '', true),
        this.diagRow('Data directory', '', diagnostics.dataDirectory, true),
        this.diagRow('Screenshots', '', diagnostics.screenshotsDirectory, true),
      ]),
    ]);
  }

  /** Live read of the foreground app, so the detector can be checked on demand. */
  private currentAppRow(): HTMLElement {
    const value = el('span', { class: 'diag__detail', text: 'Not checked yet.' });
    const button = el('button', { class: 'btn', type: 'button', text: 'Detect now' });
    button.addEventListener('click', () => {
      value.textContent = 'Detecting…';
      void window.timeTracker.getCurrentApplication().then((app) => {
        value.textContent = app
          ? `${app.name}${app.appId ? ` (${app.appId})` : ''}`
          : 'No foreground application was detected.';
      });
    });
    return el('div', { class: 'diag diag--manual' }, [
      el('span', { class: 'diag__label', text: 'Foreground app' }),
      el('div', { class: 'diag__inline' }, [value, button]),
    ]);
  }

  /** Sends a real notification so delivery can be confirmed end to end. */
  private testNotificationRow(): HTMLElement {
    const value = el('span', { class: 'diag__detail', text: 'Sends a real notification.' });
    const button = el('button', { class: 'btn', type: 'button', text: 'Send test' });
    button.addEventListener('click', () => {
      value.textContent = 'Sending…';
      void window.timeTracker.sendTestNotification().then((result) => {
        value.textContent = result.lastError
          ? `Failed: ${result.lastError}`
          : `Handed to the OS (${result.delivered} delivered). If nothing appeared, allow this app under System Settings › Notifications.`;
        void window.timeTracker.getSnapshot();
      });
    });
    return el('div', { class: 'diag diag--manual' }, [
      el('span', { class: 'diag__label', text: 'Test delivery' }),
      el('div', { class: 'diag__inline' }, [value, button]),
    ]);
  }

  private diagRow(label: string, value: string, detail: string, ok: boolean): HTMLElement {
    return el('div', { class: 'diag' }, [
      el('span', { class: 'diag__label', text: label }),
      el('div', { class: 'diag__value' }, [
        value ? el('span', { class: `pill ${ok ? 'pill--ok' : 'pill--warn'}`, text: value }) : null,
        detail ? el('span', { class: 'diag__detail', text: detail }) : null,
      ]),
    ]);
  }

  private toggleRow(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
    const input = el('input', { type: 'checkbox', class: 'checkbox' });
    (input as HTMLInputElement).checked = checked;
    input.addEventListener('change', () => onChange((input as HTMLInputElement).checked));
    return el('label', { class: 'diag diag--toggle' }, [
      el('span', { class: 'diag__label', text: label }),
      input,
    ]);
  }

  private intervalRow(currentMs: number): HTMLElement {
    const select = el('select', { class: 'select' }) as HTMLSelectElement;
    for (const seconds of [15, 30, 60, 120, 300]) {
      const option = el('option', { value: String(seconds * 1000), text: `every ${seconds}s` });
      select.append(option);
    }
    select.value = String(currentMs);
    select.addEventListener('change', () => {
      void window.timeTracker.updateSettings({ screenshotIntervalMs: Number(select.value) });
    });
    return el('label', { class: 'diag diag--toggle' }, [
      el('span', { class: 'diag__label', text: 'Screenshot interval' }),
      select,
    ]);
  }

  /** Escape hatch for verifying link storage when OS detection is unavailable. */
  private manualLinkRow(): HTMLElement {
    const input = el('input', {
      class: 'input',
      type: 'url',
      placeholder: 'https://example.com',
    }) as HTMLInputElement;
    const button = el('button', { class: 'btn', type: 'button', text: 'Record link' });

    const submit = (): void => {
      const value = input.value.trim();
      if (!value) return;
      void window.timeTracker.addManualLink(value).then((link) => {
        if (link) input.value = '';
      });
    };
    button.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') submit();
    });

    return el('div', { class: 'diag diag--manual' }, [
      el('span', { class: 'diag__label', text: 'Record manually' }),
      el('div', { class: 'diag__inline' }, [input, button]),
    ]);
  }
}
