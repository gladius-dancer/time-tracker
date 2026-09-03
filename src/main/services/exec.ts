import { execFile } from 'node:child_process';

/**
 * Run a helper binary and return stdout, or null on any failure.
 *
 * Every platform link source shells out to an OS tool that may be missing,
 * permission-blocked or slow. Failures are expected and must degrade quietly, so
 * this never throws and always enforces a timeout -- a hung `osascript` must not
 * stall the polling loop.
 */
export function run(command: string, args: string[], timeoutMs = 4_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout ?? '');
    });
  });
}

export async function commandExists(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const out = await run(probe, [command], 2_000);
  return out !== null && out.trim().length > 0;
}
