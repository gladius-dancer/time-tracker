/**
 * Publishes the focused window over D-Bus for Time Tracker.
 *
 * Wayland deliberately tells no client about another client's windows, and
 * GNOME's own `org.gnome.Shell.Introspect` rejects callers outside a built-in
 * allowlist, so an extension running inside the shell is the only place this
 * information can be read at all. The extension is the smallest thing that can
 * work: one method, returning only the focused window, computed on demand. It
 * stores nothing, watches nothing, and adds no UI.
 *
 * The payload is base64-encoded JSON. GNOME's D-Bus tooling prints strings in
 * GVariant syntax, quoting and escaping them, and a window title is arbitrary
 * user text -- apostrophes, quotes, backslashes, emoji. Base64 keeps the value a
 * single unambiguous token on the wire, so the reader extracts it with one match
 * instead of reimplementing shell quoting rules that any real title would defeat.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.timetracker.WindowInfo';
const OBJECT_PATH = '/org/timetracker/WindowInfo';

const INTERFACE = `
<node>
  <interface name="org.timetracker.WindowInfo">
    <method name="GetFocusedWindow">
      <arg type="s" direction="out" name="payload"/>
    </method>
  </interface>
</node>`;

export default class TimeTrackerWindowInfo extends Extension {
  enable() {
    // The shell's own window-to-application mapping, and the reason this
    // extension can name a Wayland window at all. `WM_CLASS` is an X11 property:
    // a native Wayland client has none, so an XWayland app like WebStorm reports
    // a class while Files, Terminal and a Wayland Firefox report nothing. The
    // tracker resolves both kinds to the same `ShellApp` the dash and alt-tab
    // use, which is also where the presentable name ("Files") comes from.
    try {
      this._tracker = Shell.WindowTracker.get_default();
    } catch (error) {
      this._tracker = null;
    }

    this._dbus = Gio.DBusExportedObject.wrapJSObject(INTERFACE, this);
    this._dbus.export(Gio.DBus.session, OBJECT_PATH);
    this._nameId = Gio.bus_own_name(
      Gio.BusType.SESSION,
      BUS_NAME,
      Gio.BusNameOwnerFlags.REPLACE,
      null,
      null,
      null,
    );
  }

  disable() {
    // Both are released so that disabling the extension really does revoke
    // access, rather than leaving a live endpoint behind until the session ends.
    if (this._nameId) {
      Gio.bus_unown_name(this._nameId);
      this._nameId = null;
    }
    if (this._dbus) {
      this._dbus.unexport();
      this._dbus = null;
    }
    this._tracker = null;
  }

  GetFocusedWindow() {
    let focused = null;
    try {
      const window = global.display.focus_window;
      if (window) {
        // Resolved through the shell where possible, so Wayland-only apps are
        // named as well as X11 ones. The `WM_CLASS` pair is still sent as a
        // fallback for the rare window the tracker cannot place.
        const app = this._tracker ? this._tracker.get_window_app(window) : null;
        focused = {
          appName: app ? app.get_name() : null,
          // A desktop-file id: "org.gnome.Nautilus.desktop".
          appId: app ? app.get_id() : null,
          wmClass: window.get_wm_class(),
          wmClassInstance: window.get_wm_class_instance(),
          title: window.get_title(),
          pid: window.get_pid(),
        };
      }
    } catch (error) {
      // Never throw across D-Bus: a shell exception here would surface as a
      // useless generic error and, worse, log-spam the user's session.
      focused = null;
    }
    const json = JSON.stringify({ focused });
    return GLib.base64_encode(new TextEncoder().encode(json));
  }
}
