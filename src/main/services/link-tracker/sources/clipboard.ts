import { clipboard } from 'electron';

import { normaliseUrl } from '../url';
import type { DetectedLink, LinkTrackingSource, SourceAvailability } from './types';

/**
 * Detects URLs the user copies while tracking. Works identically on macOS,
 * Windows and Linux and needs no special permission, which makes it the reliable
 * baseline the platform-specific browser sources build on top of.
 */
export class ClipboardLinkSource implements LinkTrackingSource {
  readonly id = 'clipboard';
  readonly label = 'Clipboard URLs';

  private lastSeen: string | null = null;

  async probe(): Promise<SourceAvailability> {
    return { available: true, detail: 'Records URLs copied to the clipboard while tracking.' };
  }

  async reset(): Promise<void> {
    // Seed with whatever is already on the clipboard so a URL copied *before*
    // tracking started is not attributed to this session.
    try {
      this.lastSeen = await clipboard.readText();
    } catch {
      this.lastSeen = null;
    }
  }

  async poll(): Promise<DetectedLink[]> {
    let text: string;
    try {
      // `clipboard.readText()` returns a promise from Electron 44 onwards and a
      // plain string before it; awaiting handles both.
      text = await clipboard.readText();
    } catch {
      return [];
    }
    if (!text || text === this.lastSeen) return [];
    this.lastSeen = text;

    const url = normaliseUrl(text.trim());
    if (!url) return [];
    return [{ url, title: null, source: 'clipboard' }];
  }
}
