"""HTTP integration tests; no real desktop input or camera required."""

from __future__ import annotations

import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch

from companion.server import COMMANDS, CompanionServer, DesktopController


class CompanionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "site"
        self.root.mkdir()
        (self.root / "index.html").write_text("<html>MotionKey test</html>")
        (self.root / "main.js").write_text("console.log('test')")
        (Path(self.temp.name) / "private.txt").write_text("outside web root")
        self.server = CompanionServer(0, token="test-token-only", dry_run=True, web_root=self.root)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, method="GET", path="/health", *, body=None, headers=None, auth=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=3)
        outgoing = {"Authorization": "Bearer test-token-only"} if auth else {}
        if body is not None:
            outgoing["Content-Type"] = "application/json"
            if not isinstance(body, str):
                body = json.dumps(body)
        outgoing.update(headers or {})
        conn.request(method, path, body=body, headers=outgoing)
        response = conn.getresponse()
        result = response.read()
        status, response_headers = response.status, dict(response.getheaders())
        conn.close()
        return status, response_headers, result

    def command(self, command="play_pause", **kwargs):
        return self.request("POST", "/command", body={"command": command}, **kwargs)

    def test_health_describes_dry_run_and_authentication(self):
        status, _, body = self.request(auth=False)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["mode"], "dry-run")
        self.assertFalse(json.loads(body)["authenticated"])
        _, _, body = self.request()
        self.assertTrue(json.loads(body)["authenticated"])
        self.assertNotIn(b"test-token-only", body)

    def test_every_supported_command_dispatches_and_records_dry_run(self):
        for command in COMMANDS:
            self.server.last_command = float("-inf")
            status, _, body = self.command(command)
            self.assertEqual(status, 200, command)
            self.assertEqual(json.loads(body), {"ok": True, "command": command, "mode": "dry-run"})
        self.assertEqual(self.server.controller.executed, list(COMMANDS))

    def test_requires_token_for_commands_and_status(self):
        self.assertEqual(self.command(auth=False)[0], 401)
        self.assertEqual(self.command(headers={"Authorization": "Bearer wrong"})[0], 401)
        self.assertEqual(self.request(path="/status", auth=False)[0], 401)
        self.assertEqual(self.request(path="/status")[0], 200)
        self.assertEqual(self.server.controller.executed, [])

    def test_rejects_untrusted_origin_even_with_valid_token(self):
        status, headers, _ = self.command(headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.server.controller.executed, [])

    def test_rejects_dns_rebinding_host(self):
        self.assertEqual(self.command(headers={"Host": "attacker.example"})[0], 403)
        self.assertEqual(self.request(headers={"Host": "attacker.example"})[0], 403)

    def test_cors_preflight_and_command_for_allowed_origin(self):
        origin = "http://localhost:5173"
        status, headers, _ = self.request("OPTIONS", "/command", auth=False, headers={"Origin": origin})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
        self.assertIn("Authorization", headers["Access-Control-Allow-Headers"])
        self.assertEqual(self.command(headers={"Origin": origin})[0], 200)

    def test_rate_limit_prevents_repeated_desktop_dispatch(self):
        self.assertEqual(self.command()[0], 200)
        self.assertEqual(self.command()[0], 429)
        self.assertEqual(self.server.controller.executed, ["play_pause"])

    def test_unknown_commands_extra_fields_and_invalid_bodies_are_rejected(self):
        for body in ({"command": "rm -rf"}, {"command": "copy", "shell": "ls"}, [], None, {"command": []}):
            payload = json.dumps(body)
            self.assertEqual(self.request("POST", "/command", body=payload)[0], 400)
        self.assertEqual(self.request("POST", "/command", body="{")[0], 400)
        self.assertEqual(self.request("POST", "/command", body="x" * 1025)[0], 413)
        self.assertEqual(self.command(headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.server.controller.executed, [])

    def test_desktop_failure_is_reported_without_success(self):
        with patch.object(self.server.controller, "execute", side_effect=RuntimeError("private details")):
            status, _, body = self.command()
        self.assertEqual(status, 503)
        self.assertNotIn(b"private details", body)
        self.assertFalse(json.loads(body)["ok"])

    def test_static_site_and_spa_route_serving(self):
        status, headers, body = self.request(path="/", auth=False)
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn(b"MotionKey test", body)
        self.assertEqual(self.request(path="/main.js", auth=False)[0], 200)
        self.assertEqual(self.request(path="/settings", headers={"Accept": "text/html"})[0], 200)
        self.assertEqual(self.request(path="/missing.js")[0], 404)

    def test_head_health_and_authenticated_status_have_get_headers_without_body(self):
        get_status, get_headers, get_body = self.request()
        status, headers, body = self.request("HEAD")
        self.assertEqual(status, get_status)
        self.assertEqual(headers["Content-Type"], get_headers["Content-Type"])
        self.assertEqual(int(headers["Content-Length"]), len(get_body))
        self.assertEqual(body, b"")
        self.assertEqual(self.request("HEAD", "/status", auth=False)[0], 401)
        self.assertEqual(self.request("HEAD", "/status")[0], 200)

    def test_head_static_models_and_wasm_are_accurate_and_missing_assets_are_404(self):
        (self.root / "models").mkdir()
        (self.root / "models" / "hand_landmarker.task").write_bytes(b"model-test-bytes")
        (self.root / "vision.wasm").write_bytes(b"\x00asm\x01\x00\x00\x00")
        status, headers, body = self.request("HEAD", "/models/hand_landmarker.task")
        self.assertEqual(status, 200)
        self.assertEqual(int(headers["Content-Length"]), len(b"model-test-bytes"))
        self.assertEqual(body, b"")
        status, headers, body = self.request("HEAD", "/vision.wasm")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/wasm")
        self.assertEqual(int(headers["Content-Length"]), 8)
        self.assertEqual(body, b"")
        missing_status, _, missing_body = self.request("HEAD", "/models/missing.task", headers={"Accept": "text/html"})
        self.assertEqual(missing_status, 404)
        self.assertEqual(missing_body, b"")

    def test_head_preserves_origin_and_host_restrictions(self):
        status, headers, body = self.request("HEAD", headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(body, b"")
        self.assertEqual(self.request("HEAD", headers={"Host": "attacker.example"})[0], 403)
        status, headers, body = self.request("HEAD", headers={"Origin": "http://localhost:5173"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:5173")
        self.assertEqual(body, b"")

    def test_traversal_and_symlink_escape_are_rejected(self):
        self.assertEqual(self.request(path="/%2e%2e/private.txt")[0], 403)
        (self.root / "escape.txt").symlink_to(Path(self.temp.name) / "private.txt")
        self.assertEqual(self.request(path="/escape.txt")[0], 403)
        (self.root / "nested").mkdir()
        (self.root / "nested" / "index.html").symlink_to(Path(self.temp.name) / "private.txt")
        self.assertEqual(self.request(path="/nested/")[0], 403)


class ControllerTests(unittest.TestCase):
    def test_dry_run_never_loads_pyautogui(self):
        controller = DesktopController(dry_run=True)
        self.assertIsNone(controller.gui)
        controller.execute("copy")
        self.assertEqual(controller.executed, ["copy"])
        with self.assertRaises(ValueError):
            controller.execute("launch_shell")

    def test_windows_shortcuts_and_media_dispatch(self):
        controller = DesktopController(dry_run=True)
        controller.dry_run = False
        controller.gui = MagicMock()
        with patch("companion.server.sys.platform", "win32"):
            for command in COMMANDS:
                controller.execute(command)
        gui = controller.gui
        gui.press.assert_any_call("playpause")
        gui.press.assert_any_call("nexttrack")
        gui.press.assert_any_call("prevtrack")
        gui.press.assert_any_call("volumeup")
        gui.press.assert_any_call("volumedown")
        gui.press.assert_any_call("volumemute")
        gui.hotkey.assert_any_call("ctrl", "c")
        gui.hotkey.assert_any_call("ctrl", "v")
        gui.hotkey.assert_any_call("ctrl", "z")
        gui.hotkey.assert_any_call("ctrl", "y")
        gui.hotkey.assert_any_call("ctrl", "tab")
        gui.hotkey.assert_any_call("ctrl", "shift", "tab")
        gui.hotkey.assert_any_call("win", "printscreen")
        gui.scroll.assert_any_call(4)
        gui.scroll.assert_any_call(-4)
        self.assertEqual(gui.failSafeCheck.call_count, len(COMMANDS))

    def test_macos_shortcuts_use_command_modifier_and_media_events(self):
        controller = DesktopController(dry_run=True)
        controller.dry_run = False
        controller.gui = MagicMock()
        appkit, quartz = MagicMock(), MagicMock()
        with patch("companion.server.sys.platform", "darwin"), patch.dict("sys.modules", {"AppKit": appkit, "Quartz": quartz}):
            for command in ("copy", "paste", "undo", "redo", "screenshot", "play_pause"):
                controller.execute(command)
        controller.gui.hotkey.assert_any_call("command", "c")
        controller.gui.hotkey.assert_any_call("command", "v")
        controller.gui.hotkey.assert_any_call("command", "z")
        controller.gui.hotkey.assert_any_call("command", "shift", "z")
        controller.gui.hotkey.assert_any_call("command", "shift", "3")
        self.assertEqual(quartz.CGEventPost.call_count, 2)
        calls = appkit.NSEvent.otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2_.call_args_list
        self.assertEqual(calls[0].args[7], (16 << 16) | (0xA << 8))
        self.assertEqual(calls[1].args[7], (16 << 16) | (0xB << 8))


if __name__ == "__main__":
    unittest.main()
