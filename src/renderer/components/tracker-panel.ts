import type { AppSnapshot, CaptureState, TaskView } from '../../shared/types';
import { clear, el, emptyState } from '../dom';
import { formatClock, formatCompact, formatTime } from '../format';
import type { Store } from '../store';

export interface TrackerHandlers {
  onStart(taskId: string): void;
  onStop(): void;
}

/**
 * The right-hand tracking panel: selected task, status, the large counter and the
 * single Start/Stop control.
 *
 * The counter node is created once per render and then mutated on tick, so the
 * digits never flicker and the DOM is not rebuilt every second.
 */
export class TrackerPanel {
  private clockEl: HTMLElement | null = null;
  private nextShotEl: HTMLElement | null = null;
  private runningTotalEl: HTMLElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: Store,
    private readonly handlers: TrackerHandlers,
  ) {
    this.store.subscribe((snapshot) => this.render(snapshot));
    this.store.subscribeTick((elapsedMs, nextAt) => this.renderTick(elapsedMs, nextAt));
  }

  private render(snapshot: AppSnapshot): void {
    clear(this.root);
    this.clockEl = null;
    this.nextShotEl = null;
    this.runningTotalEl = null;

    const active = snapshot.active;
    const selected = snapshot.tasks.find((t) => t.id === snapshot.selectedTaskId) ?? null;
    const subject = active
      ? (snapshot.tasks.find((t) => t.id === active.taskId) ?? null)
      : selected;

    if (!subject) {
      this.root.append(
        el('div', { class: 'tracker tracker--empty' }, [
          emptyState(
            'No task selected',
            'Pick a task on the left to see its details and start the timer.',
          ),
        ]),
      );
      return;
    }

    const isTracking = active?.taskId === subject.id;
    const elapsedMs = isTracking ? (active?.elapsedMs ?? 0) : 0;

    this.clockEl = el('div', {
      class: `clock${isTracking ? ' clock--live' : ''}`,
      text: formatClock(elapsedMs),
      role: 'timer',
      'aria-live': 'off',
    });

    this.root.append(
      el('div', { class: `tracker${isTracking ? ' tracker--live' : ''}` }, [
        el('div', { class: 'tracker__head' }, [
          el('span', { class: 'tracker__eyebrow', text: isTracking ? 'Now tracking' : 'Selected task' }),
          el('h1', { class: 'tracker__task', text: subject.name }),
          this.statusRow(subject, isTracking, active?.startedAt ?? null),
        ]),

        el('div', { class: 'tracker__clock' }, [
          this.clockEl,
          el('span', {
            class: 'tracker__clock-caption',
            text: isTracking ? 'Current session' : 'Timer stopped',
          }),
        ]),

        el('div', { class: 'tracker__stats' }, [
          this.stat('Reported total', formatCompact(subject.reportedMs)),
          this.runningTotalStat(subject.reportedMs + elapsedMs),
          this.nextScreenshotStat(snapshot, isTracking),
        ]),

        this.controls(subject, isTracking),
        this.captureRow(snapshot.capture, isTracking, snapshot),
      ]),
    );
  }

  private statusRow(task: TaskView, isTracking: boolean, startedAt: string | null): HTMLElement {
    return el('div', { class: 'tracker__status' }, [
      isTracking
        ? el('span', { class: 'badge badge--live badge--lg' }, [
            el('span', { class: 'badge__dot', 'aria-hidden': 'true' }),
            'Tracking',
          ])
        : el('span', {
            class: 'badge badge--lg',
            text: task.reportedMs > 0 ? 'Idle · has reported time' : 'Idle',
          }),
      startedAt ? el('span', { class: 'tracker__since', text: `Started ${formatTime(startedAt)}` }) : null,
    ]);
  }

  private stat(label: string, value: string): HTMLElement {
    return el('div', { class: 'stat' }, [
      el('span', { class: 'stat__label', text: label }),
      el('span', { class: 'stat__value', text: value }),
    ]);
  }

  private runningTotalStat(totalMs: number): HTMLElement {
    this.runningTotalEl = el('span', { class: 'stat__value', text: formatCompact(totalMs) });
    return el('div', { class: 'stat' }, [
      el('span', { class: 'stat__label', text: 'Including this session' }),
      this.runningTotalEl,
    ]);
  }

  private nextScreenshotStat(snapshot: AppSnapshot, isTracking: boolean): HTMLElement {
    const node = el('div', { class: 'stat' }, [
      el('span', { class: 'stat__label', text: 'Next screenshot' }),
    ]);
    this.nextShotEl = el('span', {
      class: 'stat__value',
      text: this.nextShotText(snapshot.active?.nextScreenshotAtEpochMs ?? null, isTracking, snapshot),
    });
    node.append(this.nextShotEl);
    return node;
  }

  private nextShotText(nextAt: number | null, isTracking: boolean, snapshot: AppSnapshot): string {
    if (!isTracking) return '—';
    if (!snapshot.settings.screenshotsEnabled) return 'Off';
    if (nextAt === null) return '—';
    const seconds = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
    return `in ${seconds}s`;
  }

  private controls(task: TaskView, isTracking: boolean): HTMLElement {
    const button = el('button', {
      class: `action ${isTracking ? 'action--stop' : 'action--start'}`,
      type: 'button',
    });
    button.append(
      el('span', { class: 'action__glyph', 'aria-hidden': 'true' }),
      el('span', { text: isTracking ? 'Stop tracking' : 'Start tracking' }),
    );
    button.addEventListener('click', () => {
      if (isTracking) this.handlers.onStop();
      else this.handlers.onStart(task.id);
    });

    return el('div', { class: 'tracker__controls' }, [
      button,
      el('p', {
        class: 'tracker__hint',
        text: isTracking
          ? 'Task switching is locked while the timer runs. Stopping saves the time to this task.'
          : 'Starting the timer also begins screenshot and link capture for this session.',
      }),
    ]);
  }

  /** Loading / success / error feedback for screen capture. */
  private captureRow(capture: CaptureState, isTracking: boolean, snapshot: AppSnapshot): HTMLElement | null {
    if (!isTracking || !snapshot.settings.screenshotsEnabled) return null;

    switch (capture.phase) {
      case 'capturing':
        return el('div', { class: 'capture capture--busy' }, [
          el('span', { class: 'spinner', 'aria-hidden': 'true' }),
          el('span', { text: 'Capturing screenshot…' }),
        ]);
      case 'success':
        return el('div', { class: 'capture capture--ok' }, [
          el('span', { class: 'capture__icon', text: '✓', 'aria-hidden': 'true' }),
          el('span', { text: `Screenshot captured at ${formatTime(capture.at)}` }),
        ]);
      case 'error':
        return el('div', { class: 'capture capture--error', role: 'alert' }, [
          el('span', { class: 'capture__icon', text: '!', 'aria-hidden': 'true' }),
          el('div', {}, [
            el('strong', { text: 'Screenshot failed' }),
            el('p', { class: 'capture__detail', text: capture.message }),
          ]),
        ]);
      default:
        return el('div', { class: 'capture capture--idle' }, [
          el('span', { class: 'capture__icon', text: '◷', 'aria-hidden': 'true' }),
          el('span', { text: 'Screen capture armed for this session.' }),
        ]);
    }
  }

  private renderTick(elapsedMs: number, nextAt: number | null): void {
    const snapshot = this.store.snapshot;
    if (!snapshot?.active) return;
    if (this.clockEl) this.clockEl.textContent = formatClock(elapsedMs);
    if (this.nextShotEl) this.nextShotEl.textContent = this.nextShotText(nextAt, true, snapshot);
    if (this.runningTotalEl) {
      const task = snapshot.tasks.find((t) => t.id === snapshot.active?.taskId);
      if (task) this.runningTotalEl.textContent = formatCompact(task.reportedMs + elapsedMs);
    }
  }
}
