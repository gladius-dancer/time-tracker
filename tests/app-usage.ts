/**
 * Deterministic checks for the application-usage coalescing rules.
 *
 * Real foreground detection depends on what the machine happens to be doing, so
 * these drive `ApplicationUsageTracker` with a scripted source instead: the exact
 * sequence of samples is fixed, which makes the merge/split/gap behaviour
 * testable rather than incidental.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ActiveApplication } from '../src/shared/types';
import { ApplicationUsageTracker } from '../src/main/services/app-usage';
import type { ActiveApplicationSource } from '../src/main/services/app-usage/sources/types';
import { Repository } from '../src/main/store/repository';

type Check = (label: string, ok: boolean, detail?: string) => void;

/** Returns a scripted app per call; `null` means "nothing relevant is active". */
class ScriptedSource implements ActiveApplicationSource {
  readonly id = 'scripted';
  readonly label = 'Scripted source';
  private index = 0;

  constructor(private readonly script: (ActiveApplication | null)[]) {}

  async probe() {
    return { available: true, detail: 'scripted' };
  }

  async detect(): Promise<ActiveApplication | null> {
    // Hold on the final entry once the script runs out.
    const entry = this.script[Math.min(this.index, this.script.length - 1)] ?? null;
    this.index += 1;
    return entry;
  }
}

function app(name: string, appId: string): ActiveApplication {
  return { name, appId, processName: name.toLowerCase(), detectedAt: new Date().toISOString() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runAppUsageChecks(check: Check): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'time-tracker-appusage-'));
  const repository = new Repository(dir, join(dir, 'screenshots'));

  const editor = app('Editor', 'com.example.editor');
  const browser = app('Browser', 'com.example.browser');

  // Editor ×3, Browser ×2, nothing, Editor ×2.
  const script = [editor, editor, editor, browser, browser, null, editor, editor];
  const tracker = new ApplicationUsageTracker(
    repository,
    { onUsageChanged: () => undefined },
    { sources: [new ScriptedSource(script)], pollIntervalMs: 60 },
  );

  tracker.startTracking('session-1', 'task-1', 'Scripted task');
  await sleep(60 * script.length + 200);
  tracker.stopTracking();

  const periods = tracker
    .getUsageForSession('session-1')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  check(
    'consecutive samples of one app merge into a single period',
    periods.length === 3,
    `${periods.length} period(s): ${periods.map((p) => p.appName).join(' → ')}`,
  );
  check('periods follow the order the apps were used', periods.map((p) => p.appName).join(',') === 'Editor,Browser,Editor');
  check('switching apps starts a new period', new Set(periods.map((p) => p.id)).size === periods.length);
  check(
    'a gap with no active application splits the periods',
    periods.length === 3 && periods[0]?.appName === 'Editor' && periods[2]?.appName === 'Editor',
  );
  check('every period carries its task and session', periods.every((p) => p.taskId === 'task-1' && p.sessionId === 'session-1'));
  check('every period has a non-negative duration and ordered timestamps',
    periods.every((p) => p.durationMs >= 0 && p.startedAt <= p.endedAt));
  check('the identifier is stored alongside the name', periods.every((p) => Boolean(p.appId && p.processName)));

  const byTask = tracker.getUsageForTask('task-1');
  check('usage is queryable by task', byTask.length === periods.length);
  check('usage for an unknown session is empty', tracker.getUsageForSession('nope').length === 0);

  // Nothing may be recorded once tracking has stopped.
  const totalAtStop = periods.reduce((sum, p) => sum + p.durationMs, 0);
  await sleep(250);
  const after = tracker.getUsageForSession('session-1');
  check('no usage accrues after stopTracking', after.reduce((sum, p) => sum + p.durationMs, 0) === totalAtStop);
  check('no periods are added after stopTracking', after.length === periods.length);

  // A source that always fails must not produce records or throw.
  const failing: ActiveApplicationSource = {
    id: 'failing',
    label: 'Failing source',
    probe: async () => ({ available: false, detail: 'always fails' }),
    detect: async () => {
      throw new Error('detection exploded');
    },
  };
  const resilient = new ApplicationUsageTracker(
    repository,
    { onUsageChanged: () => undefined },
    { sources: [failing], pollIntervalMs: 40 },
  );
  resilient.startTracking('session-2', 'task-2', 'Failing task');
  await sleep(200);
  resilient.stopTracking();
  check('a throwing detector records nothing and does not crash', resilient.getUsageForSession('session-2').length === 0);
  check('getCurrentApplication returns null when detection fails', (await resilient.getCurrentApplication()) === null);

  repository.flushSync();
  await fs.rm(dir, { recursive: true, force: true });
}
