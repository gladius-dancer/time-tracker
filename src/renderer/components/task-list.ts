import type { AppSnapshot, TaskView } from '../../shared/types';
import { clear, el, emptyState } from '../dom';
import { formatCompact } from '../format';
import type { Store } from '../store';

export interface TaskListHandlers {
  onSelect(taskId: string): void;
  onRename(taskId: string, name: string): void;
  onDelete(taskId: string): void;
}

/**
 * The left-hand task list.
 *
 * Each row shows the task name, its tracking status and its reported time. While a
 * session is running every other row is disabled, which is how the "one task at a
 * time" rule is expressed in the UI rather than only enforced on click.
 */
export class TaskList {
  private readonly countEl: HTMLElement;
  /** Live time cells, so ticks update text without rebuilding the list. */
  private timeCells = new Map<string, HTMLElement>();

  constructor(
    private readonly root: HTMLElement,
    countEl: HTMLElement,
    private readonly store: Store,
    private readonly handlers: TaskListHandlers,
  ) {
    this.countEl = countEl;
    this.store.subscribe((snapshot) => this.render(snapshot));
    this.store.subscribeTick(() => this.renderLiveTime());
  }

  private render(snapshot: AppSnapshot): void {
    clear(this.root);
    this.timeCells.clear();

    const { tasks } = snapshot;
    this.countEl.textContent = tasks.length === 0 ? '' : `${tasks.length}`;

    if (tasks.length === 0) {
      this.root.append(
        emptyState('No tasks yet', 'Add your first task above to start tracking time against it.'),
      );
      return;
    }

    const activeTaskId = snapshot.active?.taskId ?? null;
    for (const task of tasks) {
      this.root.append(this.renderRow(task, snapshot, activeTaskId));
    }
  }

  private renderRow(task: TaskView, snapshot: AppSnapshot, activeTaskId: string | null): HTMLElement {
    const isTracking = task.status === 'tracking';
    const isSelected = snapshot.selectedTaskId === task.id;
    // Selecting another task while the timer runs is blocked, so those rows are
    // visibly and semantically unavailable.
    const isLocked = activeTaskId !== null && !isTracking;

    const time = el('span', {
      class: `task__time${isTracking ? ' task__time--live' : ''}`,
      text: formatCompact(task.totalMs),
    });
    this.timeCells.set(task.id, time);

    const row = el(
      'div',
      {
        class: [
          'task',
          isSelected ? 'task--selected' : '',
          isTracking ? 'task--tracking' : '',
          isLocked ? 'task--locked' : '',
        ]
          .filter(Boolean)
          .join(' '),
        role: 'option',
        tabindex: isLocked ? -1 : 0,
        'aria-selected': isSelected ? 'true' : 'false',
        'aria-disabled': isLocked ? 'true' : 'false',
        title: isLocked ? 'Stop the current timer to switch tasks' : task.name,
      },
      [
        el('span', { class: 'task__indicator', 'aria-hidden': 'true' }),
        el('div', { class: 'task__body' }, [
          el('span', { class: 'task__name', text: task.name }),
          el('span', { class: 'task__status' }, [
            isTracking
              ? el('span', { class: 'badge badge--live' }, [
                  el('span', { class: 'badge__dot', 'aria-hidden': 'true' }),
                  'Tracking',
                ])
              : el('span', { class: 'badge', text: task.reportedMs > 0 ? 'Reported' : 'Not started' }),
          ]),
        ]),
        el('div', { class: 'task__meta' }, [
          time,
          el('div', { class: 'task__tools' }, [
            this.toolButton('Rename', 'rename', () => this.promptRename(task)),
            this.toolButton('Delete', 'delete', () => this.handlers.onDelete(task.id)),
          ]),
        ]),
      ],
    );

    if (!isLocked) {
      row.addEventListener('click', () => this.handlers.onSelect(task.id));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.handlers.onSelect(task.id);
        }
      });
    }
    return row;
  }

  private toolButton(label: string, kind: string, onClick: () => void): HTMLElement {
    const button = el('button', {
      class: `task__tool task__tool--${kind}`,
      type: 'button',
      title: label,
      'aria-label': label,
    });
    button.textContent = kind === 'rename' ? '✎' : '✕';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  private promptRename(task: TaskView): void {
    const name = window.prompt('Rename task', task.name);
    if (name && name.trim() && name.trim() !== task.name) {
      this.handlers.onRename(task.id, name.trim());
    }
  }

  /** Keeps the tracked row's time cell ticking without re-rendering the list. */
  private renderLiveTime(): void {
    const snapshot = this.store.snapshot;
    const active = snapshot?.active;
    if (!snapshot || !active) return;
    const cell = this.timeCells.get(active.taskId);
    const task = snapshot.tasks.find((t) => t.id === active.taskId);
    if (cell && task) cell.textContent = formatCompact(task.reportedMs + active.elapsedMs);
  }
}
