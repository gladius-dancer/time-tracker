/**
 * What kind of Linux desktop session the app is running in.
 *
 * The obvious test -- "`WAYLAND_DISPLAY` is set and `DISPLAY` is not" -- is
 * wrong on every mainstream Wayland desktop, because they all run XWayland and
 * therefore all export `DISPLAY` as well. GNOME on Ubuntu sets
 * `WAYLAND_DISPLAY=wayland-0` *and* `DISPLAY=:0` at once.
 *
 * What follows from a Wayland session is the same either way, and is the reason
 * this distinction matters at all:
 *
 *   - screen capture goes through xdg-desktop-portal, whichever windowing
 *     backend the app itself is drawing with;
 *   - X11 window tools still run, but see only the handful of legacy X11 clients,
 *     never the native Wayland windows the user is actually looking at -- so a
 *     source built on them reports "available" while observing nothing.
 */
export function isWaylandSession(): boolean {
  if (process.platform !== 'linux') return false;
  return process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;
}
