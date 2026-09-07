#!/usr/bin/env python3
"""Silent multi-monitor capture on Wayland, via xdg-desktop-portal + PipeWire.

Wayland gives no client the screen contents directly; the only route is the
ScreenCast portal, and Electron's own `desktopCapturer` re-opens that portal from
scratch on every call, which is why the compositor shows its "Share Screen"
picker each time. This helper opens the same portal with `persist_mode=2`, so the
compositor hands back a `restore_token` that is written to disk: the picker
appears once, on the first ever capture, and every later run passes the token
back and is approved without any user interaction.

With `--grant-only` it stops once the compositor has approved and stored the
token, without pulling any frames. That is what lets the app ask for screen
sharing when it starts, at a moment the user is expecting to be asked, rather
than springing a dialog on them mid-task at the first scheduled capture.

Speaks JSON on stdout so the Electron side never parses prose:

    {"ok": true,  "restored": true, "monitors": [{"file": "...", "x": 0, ...}]}
    {"ok": false, "reason": "cancelled", "error": "..."}

`reason` is one of: cancelled | unsupported | timeout | capture-failed.
Exit status is 0 only when "ok" is true.
"""

import json
import os
import random
import string
import sys
import tempfile

# The imports below are the whole platform dependency, and a distro can ship
# Python without them. Report that as data rather than as a traceback, so the app
# can tell the user which packages to install.
try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gio, GLib, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment probe
    print(json.dumps({"ok": False, "reason": "unsupported", "error": str(exc)}))
    sys.exit(1)

PORTAL_BUS = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
SCREENCAST_IFACE = "org.freedesktop.portal.ScreenCast"

MONITOR = 1  # SelectSources `types` bitmask: monitors only, never windows.
CURSOR_EMBEDDED = 2  # Draw the pointer into the image, as the other platforms do.
PERSIST_UNTIL_REVOKED = 2  # The setting that produces a restore_token at all.

# The portal call is bounded because it blocks on a compositor dialog the very
# first time; without a deadline a user who walks away would hang the capture.
PORTAL_TIMEOUT_S = 120
# Frames arrive continuously once the stream is live; a handful of buffers is
# enough to get past the initial blank/partial ones some compositors emit.
WARMUP_BUFFERS = 3
PIPELINE_TIMEOUT_S = 15


def handle_token() -> str:
    return "tt" + "".join(random.choices(string.ascii_lowercase + string.digits, k=10))


class PortalSession:
    """One ScreenCast conversation: create, select, start, open the PipeWire fd."""

    def __init__(self, token_path: str) -> None:
        self.token_path = token_path
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        # Request objects are published under the caller's own bus name.
        self.sender = self.bus.get_unique_name()[1:].replace(".", "_")
        self.loop = GLib.MainLoop()
        self.saved_token = self._load_token()
        self.streams: list = []
        self.fd = -1
        self.failure: tuple[str, str] | None = None

    def _load_token(self) -> str | None:
        try:
            with open(self.token_path, encoding="utf-8") as fh:
                return json.load(fh).get("restore_token") or None
        except (OSError, ValueError):
            # No prior grant, or a corrupt file: fall back to asking once.
            return None

    def _store_token(self, token: str) -> None:
        try:
            directory = os.path.dirname(self.token_path)
            if directory:
                os.makedirs(directory, exist_ok=True)
            # Written via a temp file so a crash mid-write cannot leave a corrupt
            # token behind, which would silently re-prompt the user forever.
            fd, tmp = tempfile.mkstemp(dir=directory or None)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump({"restore_token": token}, fh)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.token_path)
        except OSError as exc:
            # Not fatal: this capture succeeds, the next one just asks again.
            print(f"[portal-capture] could not store restore token: {exc}", file=sys.stderr)

    def _call(self, method: str, params: GLib.Variant) -> None:
        self.bus.call_sync(PORTAL_BUS, PORTAL_PATH, SCREENCAST_IFACE, method, params,
                           None, Gio.DBusCallFlags.NONE, -1, None)

    def _on_response(self, token: str, then) -> None:
        """Portal methods reply asynchronously through a per-request Response signal."""
        path = f"{PORTAL_PATH}/request/{self.sender}/{token}"

        def handler(_conn, _sender, _obj, _iface, _signal, params):
            code, results = params.unpack()
            self.bus.signal_unsubscribe(subscription)
            if code != 0:
                # 1 = the user dismissed the dialog, 2 = the portal ended it.
                self.failure = (
                    "cancelled",
                    "Screen sharing was not approved."
                    if code == 1
                    else "The desktop portal ended the screen-sharing request.",
                )
                self.loop.quit()
                return
            try:
                then(results)
            except Exception as exc:  # noqa: BLE001 - must not kill the main loop
                self.failure = ("capture-failed", str(exc))
                self.loop.quit()

        subscription = self.bus.signal_subscribe(
            PORTAL_BUS, "org.freedesktop.portal.Request", "Response", path, None,
            Gio.DBusSignalFlags.NONE, handler)

    def open(self) -> None:
        token = handle_token()
        self._on_response(token, lambda results: self._select(results["session_handle"]))
        self._call("CreateSession", GLib.Variant("(a{sv})", ({
            "handle_token": GLib.Variant("s", token),
            "session_handle_token": GLib.Variant("s", handle_token()),
        },)))

        deadline = GLib.timeout_add_seconds(PORTAL_TIMEOUT_S, self._timed_out)
        self.loop.run()
        GLib.source_remove(deadline)

    def _timed_out(self) -> bool:
        self.failure = ("timeout", f"The desktop portal did not respond within {PORTAL_TIMEOUT_S}s.")
        self.loop.quit()
        return GLib.SOURCE_REMOVE

    def _select(self, session: str) -> None:
        token = handle_token()
        options = {
            "handle_token": GLib.Variant("s", token),
            "types": GLib.Variant("u", MONITOR),
            "multiple": GLib.Variant("b", True),
            "cursor_mode": GLib.Variant("u", CURSOR_EMBEDDED),
            "persist_mode": GLib.Variant("u", PERSIST_UNTIL_REVOKED),
        }
        # The token is what turns the second and every later run into a silent one.
        if self.saved_token:
            options["restore_token"] = GLib.Variant("s", self.saved_token)
        self._on_response(token, lambda _results: self._start(session))
        self._call("SelectSources", GLib.Variant("(oa{sv})", (session, options)))

    def _start(self, session: str) -> None:
        token = handle_token()
        self._on_response(token, lambda results: self._started(session, results))
        self._call("Start", GLib.Variant("(osa{sv})", (
            session, "", {"handle_token": GLib.Variant("s", token)})))

    def _started(self, session: str, results: dict) -> None:
        # The compositor may rotate the token on each grant, so always re-store it.
        if results.get("restore_token"):
            self._store_token(results["restore_token"])
        self.streams = [(node_id, dict(props)) for node_id, props in results.get("streams", [])]
        if not self.streams:
            self.failure = ("capture-failed", "The portal returned no monitor streams.")
            self.loop.quit()
            return

        reply, fd_list = self.bus.call_with_unix_fd_list_sync(
            PORTAL_BUS, PORTAL_PATH, SCREENCAST_IFACE, "OpenPipeWireRemote",
            GLib.Variant("(oa{sv})", (session, {})), GLib.VariantType("(h)"),
            Gio.DBusCallFlags.NONE, -1, None, None)
        self.fd = fd_list.get(reply.unpack()[0])
        self.loop.quit()


def grab(fd: int, node_id: int, destination: str) -> str | None:
    """Pull one frame off a PipeWire node into a PNG. Returns an error, or None."""
    # Each pipeline takes its own dup of the fd: GStreamer closes what it is given.
    pipeline = Gst.parse_launch(
        f"pipewiresrc fd={os.dup(fd)} path={node_id} num-buffers={WARMUP_BUFFERS} "
        f"! videoconvert ! pngenc snapshot=true ! filesink location=\"{destination}\"")
    pipeline.set_state(Gst.State.PLAYING)
    message = pipeline.get_bus().timed_pop_filtered(
        PIPELINE_TIMEOUT_S * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    pipeline.set_state(Gst.State.NULL)

    if message is None:
        return f"Timed out waiting for a frame from monitor {node_id}."
    if message.type == Gst.MessageType.ERROR:
        error, _debug = message.parse_error()
        return error.message
    if not os.path.exists(destination) or os.path.getsize(destination) == 0:
        return f"Monitor {node_id} produced an empty image."
    return None


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    grant_only = "--grant-only" in sys.argv
    if len(args) < 2:
        print(json.dumps({"ok": False, "reason": "capture-failed",
                          "error": "usage: portal-capture.py [--grant-only] <token-file> <output-dir>"}))
        return 1
    token_path, out_dir = args[0], args[1]
    os.makedirs(out_dir, exist_ok=True)

    session = PortalSession(token_path)
    try:
        session.open()
    except GLib.Error as exc:
        reason = "unsupported" if "ServiceUnknown" in str(exc) else "capture-failed"
        print(json.dumps({"ok": False, "reason": reason, "error": exc.message}))
        return 1

    if session.failure:
        reason, detail = session.failure
        print(json.dumps({"ok": False, "reason": reason, "error": detail}))
        return 1

    # Asking for consent and taking a picture are the same portal conversation up
    # to this point; only the frame grab below is skipped when all we wanted was
    # the grant. The token has already been written by `_started`.
    Gst.init(None)
    monitors = []
    for index, (node_id, props) in enumerate(session.streams):
        destination = os.path.join(out_dir, f"monitor-{index}.png")
        error = None if grant_only else grab(session.fd, node_id, destination)
        # Geometry is what lets the app pair a stream with the right monitor;
        # the portal reports it in the compositor's own layout coordinates.
        position = props.get("position") or (0, 0)
        size = props.get("size") or (0, 0)
        monitor = {
            "index": index,
            "x": int(position[0]),
            "y": int(position[1]),
            "width": int(size[0]),
            "height": int(size[1]),
        }
        if error:
            monitor["error"] = error
        elif not grant_only:
            monitor["file"] = destination
        monitors.append(monitor)

    print(json.dumps({"ok": True, "restored": bool(session.saved_token), "monitors": monitors}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
