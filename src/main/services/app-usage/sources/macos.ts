import type { ActiveApplication, SourceStatus } from '../../../../shared/types';
import { run } from '../../exec';
import type { ActiveApplicationSource } from './types';

/**
 * Reads the frontmost application with `lsappinfo`.
 *
 * Deliberately chosen over the more obvious
 * `tell application "System Events" to … whose frontmost is true`: the System
 * Events route is gated behind the Automation privacy prompt, whereas
 * `lsappinfo` queries Launch Services directly and needs no permission at all.
 * The AppleScript form is kept only as a fallback.
 */
export class MacActiveApplicationSource implements ActiveApplicationSource {
  readonly id = 'macos-lsappinfo';
  readonly label = 'Frontmost app (Launch Services)';

  async probe(): Promise<Omit<SourceStatus, 'id' | 'label'>> {
    if (process.platform !== 'darwin') return { available: false, detail: 'macOS only.' };
    const current = await this.detect();
    return current
      ? { available: true, detail: `Reading the frontmost application (currently ${current.name}).` }
      : { available: false, detail: 'lsappinfo did not return a frontmost application.' };
  }

  async detect(): Promise<ActiveApplication | null> {
    const asn = (await run('/usr/bin/lsappinfo', ['front'], 3_000))?.trim();
    if (asn) {
      const info = await run('/usr/bin/lsappinfo', ['info', '-only', 'name,bundleID', asn], 3_000);
      if (info) {
        // Output is a set of "key"="value" lines.
        const name = info.match(/"LSDisplayName"="([^"]*)"/)?.[1];
        const bundleId = info.match(/"CFBundleIdentifier"="([^"]*)"/)?.[1] ?? null;
        if (name) {
          return {
            name,
            appId: bundleId,
            // The last bundle-id segment is the closest thing to a process name here.
            processName: bundleId ? (bundleId.split('.').pop() ?? null) : name,
            detectedAt: new Date().toISOString(),
          };
        }
      }
    }
    return this.detectViaAppleScript();
  }

  /** Fallback for the rare case Launch Services reports nothing. */
  private async detectViaAppleScript(): Promise<ActiveApplication | null> {
    const out = await run(
      '/usr/bin/osascript',
      ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
      4_000,
    );
    const name = out?.trim();
    if (!name) return null;
    return { name, appId: null, processName: name, detectedAt: new Date().toISOString() };
  }
}
