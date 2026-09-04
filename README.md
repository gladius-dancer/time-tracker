# Time Tracker

A cross-platform desktop time tracker built on Electron. Track time against tasks,
capture periodic screenshots and the links opened during a session, and inspect all
of it through an opt-in Debug Mode.

Builds for **macOS** (universal: Apple Silicon + Intel), **Windows** (x64 + arm64)
and **Linux** (x64 + arm64).

---

## Quick start

**Requires Node >= 22.12** (see `.nvmrc`). Electron 40+ and electron-builder 26+
both `require()` ESM modules, which older Node releases cannot do.

```bash
nvm use          # or otherwise select Node >= 22.12
npm install
npm start
```

| Script | What it does |
| --- | --- |
| `npm start` | Build, then launch the app |
| `npm run dev` | Rebuild on change (run `electron .` alongside it) |
| `npm run build` | Bundle main, preload and renderer into `dist/` |
| `npm run typecheck` | Type-check main/preload and renderer projects |
| `npm test` | Typecheck + smoke + end-to-end |
| `npm run smoke` | Main-process test under plain Node (`electron` aliased to a stub) |
| `npm run smoke:electron` | The same test under the real Electron runtime |
| `npm run test:e2e` | Drives the **real running app** over the DevTools protocol |
| `npm run package:mac` \| `:win` \| `:linux` \| `:all` | Produce installers in `release/` |

### Tests

Two layers, no test dependencies:

* **`npm run smoke`** builds the main process with the `electron` module aliased to
  an in-memory stub (`tests/electron-stub.ts`), then exercises persistence,
  scheduling, dedupe, restart and crash recovery.
* **`npm run test:e2e`** launches the built app with remote debugging on an
  isolated profile, attaches via a dependency-free CDP client
  (`tests/e2e/cdp.mjs`), and drives the real UI: create a task, start the timer,
  copy a URL to the clipboard, stop, check reported time, toggle Debug Mode.

---

## Architecture

```
src/
  shared/            types.ts, ipc.ts — the contract all three processes share
  main/              privileged process: persistence, capture, clock, OS access
    app-controller.ts    composes the services, owns the snapshot broadcast
    ipc/handlers.ts      the only renderer-invocable surface
    window.ts            hardened BrowserWindow
    store/               json-store.ts (atomic writes) + repository.ts (domain)
    services/
      time-tracker.ts    the authoritative clock
      screenshot.ts      scheduling, capture, permission handling
      notifications.ts   desktop notifications
      exec.ts            timeout-guarded helper for shelling out to OS tools
      link-tracker/      pluggable per-OS URL detection
      app-usage/         ApplicationUsageTracker + per-OS foreground detectors
  preload/           contextBridge surface — no ipcRenderer escape hatch
  renderer/          UI: store + components, no Node access at all
```

Each concern is a separate module with its own boundary, so screenshot capture,
link tracking, timing, persistence and UI can each be changed without touching
the others.

### Security posture

* `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.
* The renderer reaches the system only through a fixed list of named methods on
  `window.timeTracker`. There is no generic `invoke(channel, …)` passthrough.
* Every IPC handler validates its arguments before doing anything.
* A strict CSP in `index.html`; navigation and window-open are refused, and only
  `http(s)` URLs are ever handed to the OS browser.

### IPC API

Request/response (`ipcRenderer.invoke`):

| Method | Purpose |
| --- | --- |
| `getSnapshot()` | Full UI state |
| `createTask` / `renameTask` / `deleteTask` / `selectTask` | Task management |
| `startTracking(taskId)` / `stopTracking()` | Session control |
| `updateSettings(patch)` | Debug Mode, interval, capture toggles |
| `getDebugData()` | Screenshots, links and app usage grouped by session |
| `getCurrentApplication()` | The foreground application right now |
| `getUsageForSession(id)` / `getUsageForTask(id)` | Recorded application usage |
| `readScreenshotDataUrl(id)` / `revealScreenshot(id)` | Debug Mode image access |
| `openLinkExternally(url)` / `addManualLink(url)` | Debug Mode link actions |

Push events (main → renderer): `SnapshotChanged`, `Tick`, `ActivityChanged`, `Toast`.

---

## How the pieces work

### Timing

Elapsed time is derived from wall-clock timestamps, never accumulated from timer
callbacks, and the authoritative clock lives in the **main** process. The 1s
interval only pushes a refreshed value to the UI, so a minimised, occluded or
throttled window cannot cause drift. Background throttling is disabled and a
`powerSaveBlocker` is held for the duration of a session.

If the app is killed mid-session, the next launch closes the orphaned session at
the last moment it has evidence for (its newest screenshot or link) instead of
booting into a phantom running state.

### Screenshots

`desktopCapturer` captures the primary display once per interval (default 60s),
downscaled to 1920px wide and written as PNG. The scheduler aims at an absolute
target time and re-arms *before* the capture runs, so a slow capture never delays
the next one or the clock. Failures are stored as first-class records with
`status: 'failed'` and a reason, visible in Debug Mode.

On macOS the app checks Screen Recording permission and reports a clear,
actionable message when it is missing rather than silently capturing nothing.
Every successful capture raises a desktop notification naming the task; a
notification failure never affects tracking.

### Opened links

There is no cross-platform OS API for "links the user opened", so detection is
composed from pluggable sources, each reporting its own availability in the Debug
Mode diagnostics panel:

| Source | Platform | Notes |
| --- | --- | --- |
| Clipboard URLs | all | No permission needed. The reliable baseline. |
| Browser tabs (AppleScript) | macOS | Reads the front tab of running browsers. Needs Automation permission. |
| Address bar (UI Automation) | Windows | Reads Chromium/Edge/Firefox address bars via PowerShell. |
| Window titles (X11) | Linux | Needs `wmctrl` or `xdotool`; only works when the URL is in the title. |
| `timetracker://link?url=…` | all | Integration hook, e.g. for a browser extension. |

Only browsers that are already running are queried — nothing is ever launched.
Polling happens **only** while a session is active; outside one, the tracker does
no work at all. URLs are canonicalised and de-duplicated per session.

### Application usage

`ApplicationUsageTracker` samples the foreground application every 2 seconds while
a session runs and exposes a stable API to the main process:

```ts
startTracking(sessionId, taskId)   stopTracking()
getCurrentApplication()
getUsageForSession(sessionId)      getUsageForTask(taskId)
```

Detection is isolated behind one `ActiveApplicationSource` per platform, so the
tracker itself contains no OS-specific code:

| Platform | How | Permission |
| --- | --- | --- |
| macOS | `lsappinfo front` → Launch Services (AppleScript fallback) | none |
| Windows | `GetForegroundWindow` + `GetWindowThreadProcessId` via PowerShell | none |
| Linux | `xprop`/`xdotool` on `_NET_ACTIVE_WINDOW`, process name from `/proc` | X11 only |

`lsappinfo` is used on macOS in preference to the more common
`System Events … whose frontmost is true`, because the AppleScript route triggers
the Automation privacy prompt and Launch Services does not.

Consecutive samples of the same application **extend one period** rather than
writing a row per poll, so storage stays proportional to how often the user
switches apps. A period records the app name, its identifier (bundle id or
executable), process name, start, end, duration, task and session. The open period
is written to disk as it grows, so an unclean exit costs at most one interval.

Time is only attributed while an application is actually detected. A failed
detection, a desktop with nothing focused, or a machine that slept all close the
open period and leave a gap — the durations are deliberately allowed not to sum to
the session length. Tracking stops the instant the session does, not on the next
poll, and a detector that throws is logged once and then suppressed so a broken
platform cannot flood the log.

### Debug Mode

Off by default. While off, no screenshot or link UI is rendered and the debug data
is not even requested. Turning it on reveals a visually distinct section with
four tabs — Screenshots, Opened Links, Applications Used and Diagnostics — with
everything grouped by tracking session and labelled with its task and timestamp.

**Applications Used** shows each application's name and identifier, total time, how
many usage periods it accounts for, and its first/last use, under three groupings:
by task, by session (with the individual periods expandable) and by application
across every session. All three are roll-ups of the same periods, so the totals
agree however the data is sliced.

Debug Mode gates **display only**. Screenshots, links and application usage are all
still collected while it is off; the UI simply does not render them, and the debug
payload is never requested.

---

## Data persistence

Everything lives under Electron's `userData` directory:

| Platform | Location |
| --- | --- |
| macOS | `~/Library/Application Support/Time Tracker/` |
| Windows | `%APPDATA%\Time Tracker\` |
| Linux | `~/.config/Time Tracker/` |

* `time-tracker.json` — tasks, reported time, sessions, screenshot metadata,
  opened links, application usage, settings and the current selection.
* `screenshots/` — the PNG files.

Writes are atomic (temp file → fsync → rename) and debounced, with a synchronous
flush on quit and a `.bak` fallback if the primary file is ever unreadable.

**Why JSON rather than SQLite:** this app ships a single universal build per OS,
and a native module such as `better-sqlite3` would need per-architecture rebuilds
for every target. `Repository` is the only consumer of the storage layer, so the
engine can be swapped without touching the domain code if the data ever outgrows a
document store.

---

## Platform permissions

* **macOS** — Screen Recording (System Settings › Privacy & Security) for
  screenshots; Automation for reading browser tabs. Both are requested by the OS on
  first use and handled gracefully when declined. In development the permission
  attaches to the *Electron* binary rather than to "Time Tracker", so grant it to
  Electron when running `npm start`; a packaged build prompts under its own name.
* **Windows** — no special permissions. UI Automation is the same channel screen
  readers use, and the foreground-window API needs no elevation.
* **Linux** — screenshots need a portal-capable session; window-title scanning and
  foreground-application detection need `xprop`/`wmctrl`/`xdotool` and do not work
  under Wayland. Clipboard detection works everywhere.

Every detector reports its own availability in Debug Mode › Diagnostics, so an
unsupported OS or a declined permission is visible rather than silent.

## Packaging notes

`npm run package:mac` produces a **universal** DMG and ZIP — one binary containing
both `x86_64` and `arm64`. Windows and Linux each build for x64 and arm64.

If a Developer ID certificate is present in the keychain, electron-builder signs
the macOS build with it automatically; set `CSC_IDENTITY_AUTO_DISCOVERY=false` to
skip that. Notarisation is not configured — add Apple credentials to
`electron-builder.yml` for distribution. The entitlements Electron needs for JIT
and for AppleScript are already in `build/entitlements.mac.plist`.

## Troubleshooting

### Windows: opened links are not detected

Run the detector's own query to see what it sees:

```bash
npm run diagnose:windows
```

```
powershell -NoProfile -Sta -ExecutionPolicy Bypass -File .\windows-link-diagnostic.ps1
```

It prints the same line protocol the app parses:

| Line | Meaning |
| --- | --- |
| `##URL <value> <title>` | An address bar was read — this becomes a link |
| `##NOURL <title>` | A browser window exists but exposed no readable address bar |
| `##NOBROWSERS` | No supported browser window is open |
| `##ERR` / `##WINERR` | UI Automation itself failed |

Notes on what each outcome means:

* **`##URL` lines appear but no links are recorded** — this was the original bug.
  Chrome and Edge show `github.com/user/repo` with the scheme hidden, and the URL
  parser required `https://`, so every address bar was discarded. Address-bar
  sources now accept scheme-less values (the clipboard still does not, to avoid
  treating every copied filename as a link).
* **`##NOURL` for Firefox** — Firefox only exposes its URL bar over UI Automation
  once accessibility is active. Nothing to configure; Chromium browsers work.
* **`##NOBROWSERS`** — the browser's process name is not in the list. The script
  covers chrome, msedge, firefox, brave, opera, vivaldi, arc, librewolf, waterfox
  and chromium.
* **Nothing at all / a timeout** — UI Automation can be slow on a browser with many
  tabs. The query budget is 15s and a single slow poll no longer disables detection
  for the session; it takes five consecutive failures.

Whatever the outcome, Debug Mode › Diagnostics reports it in the
**Link detection sources** row rather than claiming the source is fine.



### macOS: "Electron.app was not opened because it contains malware"

Apple has **revoked the notarisation** of some older Electron builds — Electron
31.7.7 among them. macOS then kills the process on launch and deletes
`node_modules/electron/dist/Electron.app`. It is not a compromised download; you
can confirm the artifact is genuine by comparing the cached zip against Electron's
published checksums:

```bash
shasum -a 256 ~/Library/Caches/electron/*/electron-v31.7.7-darwin-arm64.zip
curl -sL https://github.com/electron/electron/releases/download/v31.7.7/SHASUMS256.txt | grep darwin-arm64
```

The fix is to use a currently supported Electron (this project pins 44.x), not to
disable Gatekeeper. To check any version before launching it:

```bash
spctl -a -vvv -t exec node_modules/electron/dist/Electron.app
```

`notarization indicates this code has been revoked` means it will be killed and
deleted. `code has no resources but signature indicates they must be present` is
the ordinary ad-hoc-signing message and is fine. Packaged builds signed with a
Developer ID are unaffected.
