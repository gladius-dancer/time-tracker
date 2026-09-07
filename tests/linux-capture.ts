/**
 * Checks for the three Linux/Wayland sources.
 *
 * None of them can be exercised end to end off a live session -- one needs a
 * compositor to approve a screen-share, one a browser writing to a profile, one a
 * GNOME extension that cannot be loaded without logging out -- so the OS boundary
 * is drawn at their data. The portal helper and the extension both speak a small
 * encoded protocol, browser profiles are a directory layout, and all three can be
 * faked exactly, including the shapes that only appear when something goes wrong:
 * a dismissed share dialog, a missing PipeWire plugin, one monitor of three
 * failing, a fractionally scaled display whose Electron bounds match none of the
 * portal's physical pixel numbers, an extension that is not installed, and a
 * window title full of the characters that break naive quoting.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeWindow, parseWindowInfo } from '../src/main/services/app-usage/sources/gnome-shell';
import {
  discoverProfiles,
  isProfileDirectory,
} from '../src/main/services/link-tracker/sources/browser-history';
import {
  explainFailure,
  matchFrame,
  parseHelperOutput,
  type PortalFrame,
} from '../src/main/services/wayland-capture';

type Check = (label: string, ok: boolean, detail?: string) => void;

const frame = (over: Partial<PortalFrame> = {}): PortalFrame => ({
  index: 0,
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  filePath: '/tmp/monitor-0.png',
  error: null,
  ...over,
});

export async function runLinuxCaptureChecks(check: Check): Promise<void> {
  // -- the helper's success payload ----------------------------------------
  const ok = parseHelperOutput(
    '{"ok": true, "restored": true, "monitors": [' +
      '{"index": 0, "x": 0, "y": 0, "width": 1920, "height": 1080, "file": "/tmp/a.png"}]}',
  );
  check('helper output parses', ok?.ok === true);
  check(
    'restored grant is reported',
    ok?.ok === true && ok.restored === true && ok.frames[0]?.filePath === '/tmp/a.png',
  );

  // GStreamer prints to stdout on some builds; the payload is still the last
  // line that parses, and a chatty pipeline must not look like a failure.
  const noisy = parseHelperOutput(
    'libEGL warning: egl: failed to create dri2 screen\n' +
      '{"ok": true, "restored": true, "monitors": [{"index": 0, "file": "/tmp/a.png"}]}\n',
  );
  check('leading tool noise is ignored', noisy?.ok === true && noisy.frames.length === 1);

  check('unparseable output is null, not a throw', parseHelperOutput('Traceback…\n') === null);

  // -- one monitor failing must not void the others ------------------------
  const partial = parseHelperOutput(
    '{"ok": true, "restored": true, "monitors": [' +
      '{"index": 0, "file": "/tmp/a.png"}, {"index": 1, "error": "no frame"}]}',
  );
  check(
    'a per-monitor error is kept beside a good monitor',
    partial?.ok === true &&
      partial.frames[0]?.error === null &&
      partial.frames[1]?.error === 'no frame' &&
      partial.frames[1]?.filePath === null,
  );

  // -- failures ------------------------------------------------------------
  const denied = parseHelperOutput('{"ok": false, "reason": "cancelled", "error": "not approved"}');
  check('a dismissed dialog parses as cancelled', denied?.ok === false && denied.reason === 'cancelled');
  check(
    'the cancelled message tells the user it is asked once',
    denied?.ok === false && /once/i.test(explainFailure(denied)) && /Share/.test(explainFailure(denied)),
  );
  check(
    'a missing dependency names the packages to install',
    /apt install/.test(explainFailure({ reason: 'unsupported', error: 'No module named gi' })),
  );

  // -- pairing a monitor with its stream -----------------------------------
  const frames = [
    frame({ index: 0, x: 0, y: 0, width: 1920, height: 1080 }),
    frame({ index: 1, x: 1920, y: 0, width: 2560, height: 1440, filePath: '/tmp/monitor-1.png' }),
  ];
  check(
    'monitors pair by position, not list order',
    matchFrame(frames, { bounds: { x: 1920, y: 0, width: 2560, height: 1440 } }, 0)?.index === 1,
  );

  // A 2x display: Electron reports 1280x720 at (960, 0), the portal 2560x1440 at
  // (1920, 0). Nothing matches until the scale factor is applied.
  const scaled = [
    frame({ index: 0, x: 0, y: 0, width: 1920, height: 1080 }),
    frame({ index: 1, x: 1920, y: 0, width: 2560, height: 1440 }),
  ];
  check(
    'a scaled display pairs once its bounds are converted to physical pixels',
    matchFrame(scaled, { bounds: { x: 960, y: 0, width: 1280, height: 720 }, scaleFactor: 2 }, 0)
      ?.index === 1,
  );

  check(
    'a single monitor pairs on index when no geometry agrees',
    matchFrame([frame({ x: 7, y: 7, width: 1, height: 1 })], { bounds: { x: 0, y: 0, width: 3440, height: 1440 } }, 0)
      ?.index === 0,
  );
  check('no streams yields no match', matchFrame([], { bounds: { x: 0, y: 0, width: 1, height: 1 } }, 0) === null);

  // -- the GNOME extension's reply -----------------------------------------
  const encode = (value: unknown): string =>
    `('${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}',)\n`;

  const focused = parseWindowInfo(
    encode({ focused: { wmClass: 'Google-chrome', wmClassInstance: 'google-chrome', title: 'Docs', pid: 42 } }),
  );
  check(
    'the focused window decodes',
    focused?.wmClass === 'Google-chrome' && focused?.wmClassInstance === 'google-chrome' && focused?.pid === 42,
  );

  // -- naming a window ------------------------------------------------------
  // The bug this covers: `WM_CLASS` is an X11 property, so a Wayland-native
  // window has none, and identifying apps by it detected XWayland ones only --
  // WebStorm was recorded while Files, Terminal and Firefox were not.
  const wayland = describeWindow(
    { appName: 'Files', appId: 'org.gnome.Nautilus.desktop', wmClass: null, wmClassInstance: null, title: 'Home', pid: 9 },
    'nautilus',
  );
  check(
    'a Wayland window with no WM_CLASS is still named',
    wayland?.name === 'Files' && wayland?.appId === 'org.gnome.Nautilus' && wayland?.processName === 'nautilus',
    JSON.stringify(wayland?.name),
  );

  const xwayland = describeWindow(
    {
      appName: 'WebStorm',
      appId: 'jetbrains-webstorm.desktop',
      wmClass: 'jetbrains-webstorm',
      wmClassInstance: 'jetbrains-webstorm',
      title: 'src',
      pid: 9,
    },
    'webstorm',
  );
  check(
    'an XWayland window prefers the presentable shell name',
    xwayland?.name === 'WebStorm' && xwayland?.appId === 'jetbrains-webstorm',
  );

  const unplaced = describeWindow(
    { appName: null, appId: null, wmClass: 'Xterm', wmClassInstance: 'xterm', title: 't', pid: 9 },
    null,
  );
  check(
    'a window the shell cannot place falls back to WM_CLASS',
    unplaced?.name === 'Xterm' && unplaced?.appId === 'xterm' && unplaced?.processName === 'xterm',
  );

  check(
    'a window with no identity at all is not recorded',
    describeWindow({ appName: null, appId: null, wmClass: null, wmClassInstance: null, title: 't', pid: 9 }, null) ===
      null,
  );

  // The reason the payload is base64 at all: a real title is arbitrary user text,
  // and gdbus prints its reply in GVariant syntax, quotes and escapes included.
  const awkward = "Rustem's notes — \"quoted\" \\ backslash 😀";
  check(
    'a title with quotes, a backslash and emoji survives',
    parseWindowInfo(encode({ focused: { wmClass: 'Code', title: awkward } }))?.title === awkward,
  );

  check(
    'nothing focused is null, which is not a fault',
    parseWindowInfo(encode({ focused: null })) === null,
  );
  check(
    'no reply at all is undefined, which is',
    parseWindowInfo('') === undefined && parseWindowInfo('Error: name not provided\n') === undefined,
  );
  check('a corrupt payload does not throw', parseWindowInfo("('bm90IGpzb24=',)") === undefined);

  // -- browser profile discovery -------------------------------------------
  check('Chromium profile names are recognised', isProfileDirectory('chromium', 'Default'));
  check('numbered Chromium profiles are recognised', isProfileDirectory('chromium', 'Profile 3'));
  check('Chromium caches are not profiles', !isProfileDirectory('chromium', 'ShaderCache'));
  check('Firefox profiles are recognised', isProfileDirectory('firefox', '1m10w03d.default'));
  check('Firefox crash reports are not profiles', !isProfileDirectory('firefox', 'Crash Reports'));

  // A home directory laid out the way Ubuntu actually produces one: Chrome from
  // the .deb, Firefox from the snap.
  const home = await fs.mkdtemp(join(tmpdir(), 'time-tracker-home-'));
  try {
    await fs.mkdir(join(home, '.config/google-chrome/Default'), { recursive: true });
    await fs.writeFile(join(home, '.config/google-chrome/Default/History'), '');
    await fs.mkdir(join(home, '.config/google-chrome/ShaderCache'), { recursive: true });
    await fs.mkdir(join(home, 'snap/firefox/common/.mozilla/firefox/abc.default'), { recursive: true });
    await fs.writeFile(join(home, 'snap/firefox/common/.mozilla/firefox/abc.default/places.sqlite'), '');
    // A profile directory with no database yet -- a browser installed but never
    // launched -- must not be offered as a source.
    await fs.mkdir(join(home, '.config/chromium/Default'), { recursive: true });

    const profiles = await discoverProfiles(home);
    const labels = profiles.map((p) => p.label).sort();
    check(
      'deb and snap layouts are both discovered',
      labels.length === 2 &&
        labels[0] === 'Firefox — abc.default' &&
        labels[1] === 'Google Chrome — Default',
      labels.join(', '),
    );
    check(
      'each profile carries the engine that reads it',
      profiles.find((p) => p.label.startsWith('Google'))?.engine === 'chromium' &&
        profiles.find((p) => p.label.startsWith('Firefox'))?.engine === 'firefox',
    );
    check('a home directory with no browsers yields nothing', (await discoverProfiles(join(home, 'nope'))).length === 0);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}
