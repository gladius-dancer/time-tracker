import type { AppSnapshot, DebugData, OpenedLink, Screenshot, SessionActivity } from '../../shared/types';
import { clear, el, emptyState } from '../dom';
import { formatBytes, formatCompact, formatDateTime, formatTime } from '../format';
import type { Store } from '../store';

type Tab = 'screenshots' | 'links' | 'diagnostics';

/**
 * Debug Mode surface: screenshots, detected links and capture diagnostics.
 *
 * Kept entirely separate from the tracking UI -- when Debug Mode is off this
 * component renders nothing at all and does not even request the data, so normal
 * usage never pays for it and no captured imagery reaches the window.
 */
export class DebugPanel {
  private tab: Tab = 'screenshots';
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
      ? `${this.data.totalScreenshots} screenshots · ${this.data.totalLinks} links`
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
      this.tab === 'screenshots' ? entry.screenshots.length > 0 : entry.links.length > 0,
    );

    if (relevant.length === 0) {
      return this.tab === 'screenshots'
        ? emptyState(
            'No screenshots yet',
            'Screenshots are captured once a minute while a task is being tracked.',
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
            this.tab === 'screenshots' ? this.renderShots(entry.screenshots) : this.renderLinks(entry.links),
          ])
        : null,
    ]);
  }

  private renderShots(shots: Screenshot[]): HTMLElement {
    const grid = el('div', { class: 'shots' });
    for (const shot of shots) grid.append(this.renderShot(shot));
    return grid;
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

    figure.append(
      el('figcaption', { class: 'shot__caption' }, [
        el('span', { class: 'shot__task', text: shot.taskName }),
        el('span', { class: 'shot__time', text: formatTime(shot.capturedAt) }),
        el('span', {
          class: 'shot__detail',
          text:
            shot.status === 'captured'
              ? `${shot.width}×${shot.height} · ${formatBytes(shot.sizeBytes)}`
              : 'not saved',
        }),
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
        el('h3', { class: 'diag-group__title', text: 'Link detection sources' }),
        ...diagnostics.linkSources.map((source) =>
          this.diagRow(source.label, source.available ? 'active' : 'unavailable', source.detail, source.available),
        ),
        this.manualLinkRow(),
      ]),

      el('div', { class: 'diag-group' }, [
        el('h3', { class: 'diag-group__title', text: 'Storage' }),
        this.diagRow('Platform', diagnostics.platform, '', true),
        this.diagRow('Data directory', '', diagnostics.dataDirectory, true),
        this.diagRow('Screenshots', '', diagnostics.screenshotsDirectory, true),
      ]),
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
