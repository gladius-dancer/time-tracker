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
      link-tracker/      pluggable per-OS URL detection
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
| `getDebugData()` | Screenshots + links grouped by session |
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

### Debug Mode

Off by default. While off, no screenshot or link UI is rendered and the debug data
is not even requested. Turning it on reveals a visually distinct section with
three tabs — Screenshots, Opened Links and Diagnostics — with everything grouped
by tracking session and labelled with its task and timestamp.

---

## Data persistence

Everything lives under Electron's `userData` directory:

| Platform | Location |
| --- | --- |
| macOS | `~/Library/Application Support/Time Tracker/` |
| Windows | `%APPDATA%\Time Tracker\` |
| Linux | `~/.config/Time Tracker/` |

* `time-tracker.json` — tasks, reported time, sessions, screenshot metadata,
  opened links, settings and the current selection.
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
  readers use.
* **Linux** — screenshots need a portal-capable session; window-title scanning
  needs `wmctrl` or `xdotool` and does not work under Wayland. Clipboard detection
  works everywhere.

## Packaging notes

`npm run package:mac` produces a **universal** DMG and ZIP — one binary containing
both `x86_64` and `arm64`. Windows and Linux each build for x64 and arm64.

If a Developer ID certificate is present in the keychain, electron-builder signs
the macOS build with it automatically; set `CSC_IDENTITY_AUTO_DISCOVERY=false` to
skip that. Notarisation is not configured — add Apple credentials to
`electron-builder.yml` for distribution. The entitlements Electron needs for JIT
and for AppleScript are already in `build/entitlements.mac.plist`.

## Troubleshooting

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
