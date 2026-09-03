import type { ToastPayload } from '../../shared/ipc';
import { el } from '../dom';

/** Transient feedback for start/stop and capture errors. */
export class Toasts {
  constructor(private readonly root: HTMLElement) {}

  show({ kind, message }: ToastPayload): void {
    const toast = el('div', { class: `toast toast--${kind}`, role: 'status' }, [
      el('span', { class: 'toast__icon', text: kind === 'error' ? '!' : kind === 'success' ? '✓' : 'i' }),
      el('span', { class: 'toast__text', text: message }),
    ]);
    this.root.append(toast);

    window.setTimeout(() => toast.classList.add('toast--out'), 3_200);
    window.setTimeout(() => toast.remove(), 3_600);
  }
}
