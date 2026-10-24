#!/usr/bin/env python3
"""MotionKey's local-only, authenticated desktop command companion.

No application code, camera frames, or arbitrary shell commands are accepted.
Use --dry-run for integration tests on machines without a desktop session.
"""

from __future__ import annotations

import argparse
import hmac
import json
import mimetypes
import os
from pathlib import Path
import secrets
import shutil
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


VERSION = "1.0.0"
MAX_BODY = 1024
COMMAND_INTERVAL = 0.15
COMMANDS = (
    "play_pause", "next_track", "previous_track", "volume_up", "volume_down",
    "mute", "scroll_up", "scroll_down", "tab_next", "tab_previous", "copy",
    "paste", "undo", "redo", "enter", "escape", "screenshot",
)


class DesktopController:
    """Translate a small command allowlist to desktop input events."""

    def __init__(self, dry_run: bool = False) -> None:
        self.dry_run = dry_run
        self.executed: list[str] = []
        self.gui = None
        if not dry_run:
            if sys.platform.startswith("linux") and not os.environ.get("DISPLAY"):
                raise RuntimeError(
                    "No desktop DISPLAY is available. Run the companion on your computer "
                    "in an X11 desktop session, or use --dry-run to test the connection."
                )
            try:
                import pyautogui
            except Exception as exc:
                raise RuntimeError(
                    "Desktop input could not initialize. Install requirements-desktop.txt "
                    "in a virtual environment and run this companion in your desktop session. "
                    "See companion/README.md for operating-system requirements."
                ) from exc
            pyautogui.FAILSAFE = True
            pyautogui.PAUSE = 0.02
            self.gui = pyautogui

    @property
    def mode(self) -> str:
        return "dry-run" if self.dry_run else "desktop"

    def execute(self, command: str) -> None:
        if command not in COMMANDS:
            raise ValueError("Unsupported command")
        if self.dry_run:
            self.executed.append(command)
            # Keep diagnostic memory bounded even during a long test session.
            del self.executed[:-100]
            return
        gui = self.gui
        gui.failSafeCheck()
        modifier = "command" if sys.platform == "darwin" else "ctrl"
        keys = {
            "play_pause": "playpause", "next_track": "nexttrack",
            "previous_track": "prevtrack", "volume_up": "volumeup",
            "volume_down": "volumedown", "mute": "volumemute",
            "enter": "enter", "escape": "esc",
        }
        if command in {"play_pause", "next_track", "previous_track", "volume_up", "volume_down", "mute"}:
            self._media_key(command, keys[command])
        elif command in keys:
            gui.press(keys[command])
        elif command in {"scroll_up", "scroll_down"}:
            gui.scroll(4 if command == "scroll_up" else -4)
        elif command == "tab_next":
            gui.hotkey("ctrl", "tab")
        elif command == "tab_previous":
            gui.hotkey("ctrl", "shift", "tab")
        elif command in {"copy", "paste", "undo"}:
            gui.hotkey(modifier, {"copy": "c", "paste": "v", "undo": "z"}[command])
        elif command == "redo":
            gui.hotkey(modifier, "shift", "z") if sys.platform == "darwin" else gui.hotkey("ctrl", "y")
        elif command == "screenshot":
            if sys.platform == "darwin":
                gui.hotkey("command", "shift", "3")
            elif sys.platform == "win32":
                gui.hotkey("win", "printscreen")
            else:
                gui.press("printscreen")

    def _media_key(self, command: str, windows_key: str) -> None:
        # PyAutoGUI silently ignores unmapped media keys on macOS/X11. Use
        # those platforms' native media events rather than reporting a no-op.
        if sys.platform == "darwin":
            import AppKit
            import Quartz
            key = {"play_pause": 16, "next_track": 17, "previous_track": 18,
                   "volume_up": 0, "volume_down": 1, "mute": 7}[command]
            for state in (0xA, 0xB):
                event = AppKit.NSEvent.otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2_(
                    14, (0, 0), state << 8, 0, 0, None, 8,
                    (key << 16) | (state << 8), -1,
                )
                Quartz.CGEventPost(0, event.CGEvent())
        elif sys.platform.startswith("linux"):
            from Xlib import X, display
            from Xlib.ext.xtest import fake_input
            keysym = {"play_pause": 0x1008FF14, "next_track": 0x1008FF17,
                      "previous_track": 0x1008FF16, "volume_up": 0x1008FF13,
                      "volume_down": 0x1008FF11, "mute": 0x1008FF12}[command]
            connection = display.Display()
            try:
                keycode = connection.keysym_to_keycode(keysym)
                if not keycode:
                    raise RuntimeError("This X11 session has no mapping for the requested media key.")
                fake_input(connection, X.KeyPress, keycode)
                fake_input(connection, X.KeyRelease, keycode)
                connection.sync()
            finally:
                connection.close()
        else:
            self.gui.press(windows_key)


class CompanionServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self, port: int = 8765, *, token: str | None = None,
        dry_run: bool = False, web_root: str | Path | None = None,
        origins: list[str] | None = None,
    ) -> None:
        self.token = token or secrets.token_urlsafe(32)
        self.controller = DesktopController(dry_run=dry_run)
        self.web_root = Path(web_root).resolve() if web_root else None
        if self.web_root and not (self.web_root / "index.html").is_file():
            raise ValueError("--web-root must contain a built index.html; run npm run build first.")
        self.last_command = float("-inf")
        self.command_lock = threading.Lock()
        super().__init__(("127.0.0.1", port), CompanionHandler)
        actual_port = self.server_address[1]
        self.allowed_hosts = {f"127.0.0.1:{actual_port}", f"localhost:{actual_port}"}
        self.allowed_origins = {
            *(f"http://{host}:{p}" for host in ("127.0.0.1", "localhost") for p in (5173, 4173, actual_port)),
            *(origins or []),
        }


class CompanionHandler(BaseHTTPRequestHandler):
    server: CompanionServer
    server_version = "MotionKey/1.0"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, fmt: str, *args: object) -> None:
        # Do not log headers, bodies, or authentication tokens.
        return

    def _authenticated(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        return hmac.compare_digest(supplied.encode(), f"Bearer {self.server.token}".encode())

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        return origin is None or origin in self.server.allowed_origins

    def _check_request(self) -> bool:
        if self.headers.get("Host", "") not in self.server.allowed_hosts:
            self._json(403, {"ok": False, "error": "Untrusted Host header."}, cors=False)
            return False
        if not self._origin_allowed():
            self._json(403, {"ok": False, "error": "This browser origin is not allowed."}, cors=False)
            return False
        return True

    def _headers(self, *, cors: bool = True) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin")
        if cors and origin in self.server.allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, status: int, data: dict, *, cors: bool = True) -> None:
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self._headers(cors=cors)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def do_OPTIONS(self) -> None:
        if not self._check_request():
            return
        self.send_response(204)
        self._headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        if not self._check_request():
            return
        path = urlsplit(self.path).path
        if path == "/health":
            self._json(200, {
                "ok": True, "version": VERSION, "mode": self.server.controller.mode,
                "authenticated": self._authenticated(), "commands": list(COMMANDS),
            })
            return
        if path == "/status":
            if not self._authenticated():
                self._json(401, {"ok": False, "error": "Pair with the token shown in your companion terminal."})
                return
            self._json(200, {"ok": True, "mode": self.server.controller.mode, "authenticated": True})
            return
        if self.server.web_root:
            self._serve_file(path)
            return
        self._json(404, {"ok": False, "error": "Not found."})

    def do_HEAD(self) -> None:
        # Use the same routing, access checks, and response headers as GET.
        # Writers suppress response bodies when the request method is HEAD.
        self.do_GET()

    def _serve_file(self, path: str) -> None:
        root = self.server.web_root
        try:
            target = (root / unquote(path).lstrip("/")).resolve()
            target.relative_to(root)
        except (ValueError, OSError):
            self._json(403, {"ok": False, "error": "Path is outside the web root."})
            return
        if target.is_dir():
            target = (target / "index.html").resolve()
            if not target.is_relative_to(root):
                self._json(403, {"ok": False, "error": "Path is outside the web root."})
                return
        if not target.is_file():
            # React routes may fall back to index.html; missing assets must stay 404.
            if not Path(path).suffix and "text/html" in self.headers.get("Accept", ""):
                target = (root / "index.html").resolve()
                if not target.is_relative_to(root):
                    self._json(403, {"ok": False, "error": "Path is outside the web root."})
                    return
            else:
                self._json(404, {"ok": False, "error": "File not found."})
                return
        try:
            with target.open("rb") as file:
                self.send_response(200)
                self._headers()
                content_type = "application/wasm" if target.suffix == ".wasm" else (mimetypes.guess_type(target.name)[0] or "application/octet-stream")
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(target.stat().st_size))
                self.end_headers()
                if self.command != "HEAD":
                    shutil.copyfileobj(file, self.wfile)
        except OSError:
            self._json(404, {"ok": False, "error": "File is unavailable."})

    def do_POST(self) -> None:
        if not self._check_request():
            return
        if urlsplit(self.path).path != "/command":
            self._json(404, {"ok": False, "error": "Not found."})
            return
        if not self._authenticated():
            self._json(401, {"ok": False, "error": "Pair with the token shown in your companion terminal."})
            return
        if self.headers.get("Transfer-Encoding"):
            self._json(400, {"ok": False, "error": "Chunked requests are not supported."})
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            self._json(415, {"ok": False, "error": "Content-Type must be application/json."})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._json(400, {"ok": False, "error": "A valid Content-Length is required."})
            return
        if not 0 < length <= MAX_BODY:
            self._json(413, {"ok": False, "error": "Command request is too large or empty."})
            return
        try:
            data = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._json(400, {"ok": False, "error": "Invalid JSON."})
            return
        if not isinstance(data, dict) or set(data) != {"command"} or data["command"] not in COMMANDS:
            self._json(400, {"ok": False, "error": "Choose one of the supported desktop commands."})
            return
        with self.server.command_lock:
            now = time.monotonic()
            if now - self.server.last_command < COMMAND_INTERVAL:
                self._json(429, {"ok": False, "error": "Commands are arriving too quickly. Try again shortly."})
                return
            try:
                self.server.controller.execute(data["command"])
                self.server.last_command = time.monotonic()
            except Exception:
                self._json(503, {
                    "ok": False,
                    "error": "Desktop input failed. Check desktop/accessibility permissions and move the mouse away from screen corners.",
                })
                return
        self._json(200, {"ok": True, "command": data["command"], "mode": self.server.controller.mode})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--dry-run", action="store_true", help="Validate commands without generating desktop input.")
    parser.add_argument("--web-root", type=Path, help="Serve the built frontend directory, normally dist.")
    parser.add_argument("--origin", action="append", default=[], help="Allow this exact browser origin; repeat as needed.")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    for origin in args.origin:
        parts = urlsplit(origin)
        if parts.scheme not in {"http", "https"} or not parts.netloc or parts.path or parts.query or parts.fragment or parts.username:
            parser.error("--origin must be an exact http(s) origin without a path, for example http://localhost:5173")
    try:
        server = CompanionServer(args.port, dry_run=args.dry_run, web_root=args.web_root, origins=args.origin)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"MotionKey companion: {exc}", file=sys.stderr)
        return 1
    print(f"MotionKey companion listening at http://127.0.0.1:{server.server_address[1]}", flush=True)
    print(f"Mode: {server.controller.mode}" + (" (no desktop input will be sent)" if args.dry_run else ""), flush=True)
    print("Pairing token (paste into MotionKey's desktop connection settings):", flush=True)
    print(server.token, flush=True)
    print("Keep this terminal open. Press Ctrl+C to stop and revoke this token.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nMotionKey companion stopped.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
