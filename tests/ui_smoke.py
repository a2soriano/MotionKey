"""Browser smoke checks. Start npm run dev first; never emits desktop input.

Run: python3 tests/ui_smoke.py
Requires the Python playwright package and Chromium (or CHROMIUM_PATH).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import threading
import unittest
from urllib.request import urlopen

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'companion'))
from server import CompanionServer

URL = os.environ.get('MOTIONKEY_TEST_URL', 'http://127.0.0.1:5173')


class MotionKeyBrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            urlopen(URL, timeout=3).close()
        except OSError as exc:
            raise RuntimeError('Start npm run dev before running UI smoke checks.') from exc
        cls.companion = CompanionServer(8765, dry_run=True)
        cls.server_thread = threading.Thread(target=cls.companion.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
            headless=True,
            args=['--no-sandbox'],
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.companion.shutdown()
        cls.companion.server_close()
        cls.server_thread.join(timeout=3)

    def test_desktop_workflow_and_pairing(self):
        context = self.browser.new_context(viewport={'width': 1440, 'height': 1100}, accept_downloads=True)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL, wait_until='networkidle')
        expect(page.get_by_role('heading', name='Make your move.')).to_be_visible()
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > window.innerWidth'))
        page.screenshot(path='/tmp/motionkey-desktop.png', full_page=True)

        # Create a custom gesture requires actual recorded samples.
        page.get_by_role('button', name='Create gesture', exact=True).first.click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_label('GIVE IT A NAME').fill('My focus pose')
        expect(dialog.get_by_role('button', name='Create gesture', exact=True)).to_be_disabled()
        expect(dialog.get_by_role('button', name='Capture sample')).to_be_disabled()
        page.keyboard.press('Escape')
        expect(dialog).not_to_be_visible()

        # Toggle state and command mappings survive reload.
        palm = page.locator('.gesture-card').filter(has=page.get_by_role('heading', name='Open palm', exact=True))
        toggle = palm.get_by_role('switch', name='Enable Open palm')
        expect(toggle).to_have_attribute('aria-checked', 'true')
        toggle.click()
        expect(toggle).to_have_attribute('aria-checked', 'false')
        palm.locator('.card-main').click()
        dialog = page.get_by_role('dialog')
        # Regression: a switch inside a form must not submit the edit dialog.
        edit_toggle = dialog.get_by_role('switch', name='Enable this gesture', exact=True)
        edit_toggle.click()
        expect(dialog).to_be_visible()
        expect(edit_toggle).to_have_attribute('aria-checked', 'true')
        edit_toggle.click()
        expect(dialog).to_be_visible()
        expect(edit_toggle).to_have_attribute('aria-checked', 'false')
        dialog.locator('#command').select_option('scroll_down')
        dialog.get_by_role('button', name='Save gesture').click()
        page.reload(wait_until='networkidle')
        palm = page.locator('.gesture-card').filter(has=page.get_by_role('heading', name='Open palm', exact=True))
        expect(palm.get_by_role('switch', name='Enable Open palm')).to_have_attribute('aria-checked', 'false')
        expect(palm.locator('.command-assignment')).to_contain_text('Scroll down')

        # Library category filters display the right existing, real gestures.
        page.locator('nav button').filter(has_text='My gestures').click()
        page.get_by_role('button', name='Face', exact=True).click()
        expect(page.locator('.gesture-card')).to_have_count(4)
        expect(page.locator('.gesture-card').first).to_contain_text('Face expression')
        page.get_by_role('button', name='Custom', exact=True).click()
        expect(page.get_by_text('A gesture that’s all you.')).to_be_visible()
        page.get_by_role('button', name='Hands', exact=True).click()
        expect(page.locator('.gesture-card')).to_have_count(8)
        with page.expect_download() as download_info:
            page.get_by_role('button', name='Export profile').click()
        download = download_info.value
        self.assertEqual(download.suggested_filename, 'motionkey-gestures.json')
        exported = json.loads(Path(download.path()).read_text())
        self.assertEqual(exported['version'], 1)
        self.assertEqual(len(exported['mappings']), 12)
        self.assertNotIn('token', exported)

        # Activity distinguishes an empty session from successful control.
        page.locator('nav button').filter(has_text='Activity').click()
        expect(page.get_by_text('Every move starts somewhere.')).to_be_visible()
        expect(page.get_by_role('button', name='Clear activity')).to_be_disabled()

        # Settings persist and remain available after navigation/reload.
        page.locator('nav button').filter(has_text='Settings').click()
        slider = page.get_by_role('slider', name='Gesture hold time')
        expect(slider).to_have_value('600')
        slider.focus()
        slider.press('ArrowRight')
        expect(slider).to_have_value('700')
        page.reload(wait_until='networkidle')
        page.locator('nav button').filter(has_text='Settings').click()
        expect(page.get_by_role('slider', name='Gesture hold time')).to_have_value('700')
        page.locator('nav button').filter(has_text='Gesture studio').click()

        # Pairing rejects invalid credentials and accepts a real local dry-run helper.
        page.get_by_role('button', name='Connect desktop', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.locator('#pair-token').fill('invalid-token')
        dialog.get_by_role('button', name='Connect desktop', exact=True).click()
        expect(dialog.get_by_role('alert')).to_contain_text('does not match')
        dialog.locator('#pair-token').fill(self.companion.token)
        dialog.get_by_role('button', name='Connect desktop', exact=True).click()
        expect(page.get_by_role('button', name='Desktop connected')).to_be_visible()
        expect(page.get_by_role('status')).to_contain_text('dry-run mode')
        expect(page.get_by_role('button', name='Arm control')).to_be_disabled()
        self.assertEqual(self.companion.controller.executed, [])

        # Native camera denial (no permission or mocked recognition) is reported.
        page.get_by_role('button', name='Enable camera', exact=True).click()
        expect(page.locator('.error-banner')).to_be_visible(timeout=30000)
        expect(page.get_by_role('button', name='Enable camera', exact=True)).to_be_enabled()
        self.assertEqual(errors, [])
        context.close()

    def test_camera_model_initialization_and_lifecycle(self):
        # Chromium's native synthetic webcam exercises getUserMedia, actual WASM
        # inference and model loading. No landmarks/detections are fabricated.
        browser = self.playwright.chromium.launch(
            executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
            headless=True,
            args=['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        )
        try:
            context = browser.new_context(viewport={'width': 1440, 'height': 1000})
            page = context.new_page()
            errors = []
            model_responses = {}
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('response', lambda response: model_responses.update({response.url.rsplit('/', 1)[-1]: response.status})
                    if '/models/' in response.url or response.url.endswith('.wasm') else None)
            page.goto(URL, wait_until='networkidle')
            page.get_by_role('button', name='Connect desktop', exact=True).click()
            dialog = page.get_by_role('dialog')
            dialog.locator('#pair-token').fill(self.companion.token)
            dialog.get_by_role('button', name='Connect desktop', exact=True).click()
            expect(page.get_by_role('button', name='Desktop connected')).to_be_visible()

            page.get_by_role('button', name='Enable camera', exact=True).click()
            expect(page.get_by_role('button', name='Stop camera', exact=True)).to_be_visible(timeout=90000)
            expect(page.locator('.camera-view')).to_have_class('camera-view is-live')
            page.wait_for_function("/([1-9]\\d*) FPS/.test(document.querySelector('.view-bottom').textContent)", timeout=30000)
            self.assertGreater(page.locator('video').evaluate('video => video.videoWidth'), 0)
            self.assertGreater(page.locator('canvas').evaluate('canvas => canvas.width'), 0)
            self.assertEqual(model_responses.get('hand_landmarker.task'), 200)
            self.assertEqual(model_responses.get('face_landmarker.task'), 200)
            self.assertTrue(any(name.endswith('.wasm') and status == 200 for name, status in model_responses.items()))
            expect(page.locator('.error-banner')).not_to_be_visible()
            expect(page.get_by_role('button', name='Arm control')).to_be_enabled()
            page.screenshot(path='/tmp/motionkey-camera.png', full_page=True)

            # Pause/resume retains the live stream and gives an explicit overlay.
            page.get_by_role('button', name='Pause tracking', exact=True).click()
            expect(page.get_by_text('Recognition paused', exact=True)).to_be_visible()
            page.get_by_role('button', name='Resume tracking', exact=True).last.click()
            expect(page.get_by_text('Recognition paused', exact=True)).not_to_be_visible()

            # Recording without a visible hand cannot create bogus pose samples.
            page.get_by_role('button', name='Create gesture', exact=True).first.click()
            dialog = page.get_by_role('dialog')
            dialog.get_by_label('GIVE IT A NAME').fill('No fabricated hand')
            dialog.get_by_role('button', name='Capture sample', exact=True).click()
            expect(dialog.get_by_role('button', name='Create gesture', exact=True)).to_be_disabled()
            expect(dialog.get_by_text('Hold your pose in the camera', exact=True)).to_be_visible()
            page.keyboard.press('Escape')

            # Stop really ends the media tracks rather than hiding the preview.
            page.evaluate('window.__motionkeyTestStream = document.querySelector("video").srcObject')
            page.get_by_role('button', name='Stop camera', exact=True).click()
            expect(page.get_by_role('button', name='Enable camera', exact=True)).to_be_visible()
            self.assertTrue(page.evaluate('window.__motionkeyTestStream.getTracks().every(track => track.readyState === "ended")'))

            # Reinitialize models/stream, then navigation must stop and disarm.
            page.get_by_role('button', name='Enable camera', exact=True).click()
            expect(page.get_by_role('button', name='Stop camera', exact=True)).to_be_visible(timeout=90000)
            page.get_by_role('button', name='Arm control', exact=True).click()
            expect(page.get_by_role('button', name='Disarm', exact=True)).to_be_visible()
            page.evaluate('window.__motionkeyTestStream = document.querySelector("video").srcObject')
            page.locator('nav button').filter(has_text='My gestures').click()
            page.wait_for_function('window.__motionkeyTestStream.getTracks().every(track => track.readyState === "ended")')
            page.locator('nav button').filter(has_text='Gesture studio').click()
            expect(page.get_by_role('button', name='Enable camera', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='Arm control', exact=True)).to_be_disabled()
            self.assertEqual(self.companion.controller.executed, [])
            self.assertEqual(errors, [])
            context.close()
        finally:
            browser.close()

    def test_mobile_layout(self):
        context = self.browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, device_scale_factor=1)
        page = context.new_page()
        page.goto(URL, wait_until='networkidle')
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > window.innerWidth'))
        expect(page.get_by_role('heading', name='Make your move.')).to_be_visible()
        page.screenshot(path='/tmp/motionkey-mobile.png', full_page=True)
        page.locator('nav button').filter(has_text='My gestures').click()
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > window.innerWidth'))
        page.get_by_role('button', name='Create gesture', exact=True).first.click()
        expect(page.get_by_role('dialog')).to_be_visible()
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > window.innerWidth'))
        page.get_by_role('button', name='Close dialog').click()
        context.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
