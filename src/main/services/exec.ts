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

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Set when the helper could not be run or did not finish. */
  failure: string | null;
}

/**
 * Like `run`, but reports *why* something failed.
 *
 * `run` collapsing every failure to `null` is fine for a source that just skips a
 * poll, but useless when the user needs to know whether the tool is missing, the
 * script errored, or it simply timed out. Diagnostics surfaces this text.
 */
export function runDetailed(command: string, args: string[], timeoutMs = 4_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = stdout ?? '';
        const err = stderr ?? '';
        if (!error) {
          resolve({ ok: true, stdout: out, stderr: err, failure: null });
          return;
        }
        const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
        const code = (error as NodeJS.ErrnoException).code;
        const failure = killed
          ? `timed out after ${timeoutMs}ms`
          : code === 'ENOENT'
            ? `${command} was not found`
            : (err.trim().split('\n')[0] ?? error.message);
        resolve({ ok: false, stdout: out, stderr: err, failure });
      },
    );
  });
}

export async function commandExists(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const out = await run(probe, [command], 2_000);
  return out !== null && out.trim().length > 0;
}
