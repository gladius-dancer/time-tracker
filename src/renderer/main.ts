import { DebugPanel } from './components/debug-panel';
import { TaskList } from './components/task-list';
import { Toasts } from './components/toasts';
import { TrackerPanel } from './components/tracker-panel';
import { mustGet } from './dom';
import { Store } from './store';

/**
 * Renderer entry point.
 *
 * Its only job is composition: build the store, wire each component to it, and
 * forward user intent to the main process through the preload bridge. No
 * privileged API is reachable from here.
 */
async function bootstrap(): Promise<void> {
  const api = window.timeTracker;
  const store = new Store();
  const toasts = new Toasts(mustGet('toasts'));

  new TaskList(mustGet('task-list'), mustGet('task-count'), store, {
    onSelect: (taskId) => void api.selectTask(taskId),
    onRename: (taskId, name) => void api.renameTask(taskId, name),
    onDelete: (taskId) => {
      const snapshot = store.snapshot;
      const task = snapshot?.tasks.find((t) => t.id === taskId);
      if (!task) return;
      const confirmed = window.confirm(
        `Delete “${task.name}”?\n\nIts reported time, sessions, screenshots and links will be removed permanently.`,
      );
      if (confirmed) void api.deleteTask(taskId);
    },
  });

  new TrackerPanel(mustGet('tracker-root'), store, {
    onStart: (taskId) => void api.startTracking(taskId),
    onStop: () => void api.stopTracking(),
  });

  new DebugPanel(mustGet('debug-root'), store);

  // -- header controls -----------------------------------------------------

  const debugToggle = mustGet<HTMLInputElement>('debug-toggle');
  debugToggle.addEventListener('change', () => {
    void api.updateSettings({ debugMode: debugToggle.checked });
  });

  const livePill = mustGet('live-pill');
  const livePillText = mustGet('live-pill-text');

  const form = mustGet<HTMLFormElement>('new-task-form');
  const input = mustGet<HTMLInputElement>('new-task-input');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    input.value = '';
    void api.createTask(name);
  });

  store.subscribe((snapshot) => {
    debugToggle.checked = snapshot.settings.debugMode;
    document.body.classList.toggle('is-debug', snapshot.settings.debugMode);
    document.body.classList.toggle('is-tracking', snapshot.active !== null);

    livePill.hidden = snapshot.active === null;
    if (snapshot.active) livePillText.textContent = snapshot.active.taskName;
  });

  // -- main process events -------------------------------------------------

  api.onSnapshotChanged((snapshot) => store.setSnapshot(snapshot));
  api.onTick((tick) => store.applyTick(tick));
  api.onToast((toast) => toasts.show(toast));

  store.setSnapshot(await api.getSnapshot());
}

void bootstrap();
