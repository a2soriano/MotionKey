"""Exercise real MediaPipe WASM inference in Chromium against an official photo.

Requires the dev server (`npm run dev`), prepared models (`npm run assets`), and
Python Playwright with Chromium installed. Run:
    python tests/vision_browser.py --fixture /path/to/woman_hands.jpg
With no --fixture it downloads the official MediaPipe test photo over HTTPS.
The photo is supplied as video input; recognition/model outputs are never mocked.
Also checks real UI recognition, custom-pose persistence, and an authenticated
dry-run command. Port 8765 must be free for the test-owned companion; no desktop
keys are emitted. Uses system Chromium when available or --browser PATH.
"""
import argparse
import json
import shutil
import sys
import threading
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from server import CompanionServer

FIXTURE_URL = 'https://storage.googleapis.com/mediapipe-assets/woman_hands.jpg'

FIXTURE_CAMERA = '''(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {configurable: true, value: async () => {
        const image = new Image();
        image.src = '/__vision-test-fixture.jpg';
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const stream = canvas.captureStream(15);
        const timer = setInterval(() => context.drawImage(image, 0, 0), 66);
        stream.getTracks().forEach(track => {
            const originalStop = track.stop.bind(track);
            track.stop = () => {clearInterval(timer); originalStop();};
        });
        return stream;
    }});
})();'''


def exercise_ui(page):
    """Uses real recognition, a real authenticated HTTP helper, and dry-run input only."""
    companion = CompanionServer(8765, dry_run=True)
    thread = threading.Thread(target=companion.serve_forever, daemon=True)
    thread.start()
    try:
        page.get_by_role('button', name='Enable camera', exact=True).click()
        expect(page.get_by_role('button', name='Stop camera', exact=True)).to_be_visible(timeout=60000)
        expect(page.get_by_text('2 hands detected', exact=True)).to_be_visible(timeout=30000)
        # Real frames accumulate the 600ms gesture dwell before opening a dialog.
        page.wait_for_timeout(1800)
        page.get_by_role('button', name='Create gesture', exact=True).first.click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_label('GIVE IT A NAME').fill('Integration pose')
        for _ in range(3):
            dialog.get_by_role('button', name='Capture sample', exact=True).click()
        expect(dialog.get_by_text('3 of 3+ samples captured', exact=True)).to_be_visible()
        dialog.get_by_role('button', name='Create gesture', exact=True).click()
        saved = page.evaluate('JSON.parse(localStorage.getItem("motionkey.mappings.v1")).find(m => m.name === "Integration pose")')
        assert saved['kind'] == 'custom' and len(saved['samples']) == 3
        assert all(len(sample) == 63 for sample in saved['samples'])
        page.locator('nav button').filter(has_text='Activity').click()
        expect(page.locator('.activity-item').filter(has_text='Open palm')).to_have_count(1)
        expect(page.locator('.activity-item').first).to_contain_text('Recognized only. Desktop control is not armed.')
        assert companion.controller.executed == []

        page.reload(wait_until='networkidle')
        page.locator('nav button').filter(has_text='My gestures').click()
        page.get_by_role('button', name='Custom', exact=True).click()
        expect(page.get_by_role('heading', name='Integration pose', exact=True)).to_be_visible()
        persisted = page.evaluate('JSON.parse(localStorage.getItem("motionkey.mappings.v1")).find(m => m.name === "Integration pose")')
        assert persisted == saved
        page.locator('nav button').filter(has_text='Gesture studio').click()
        page.get_by_role('button', name='Connect desktop', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.locator('#pair-token').fill(companion.token)
        dialog.get_by_role('button', name='Connect desktop', exact=True).click()
        expect(page.get_by_role('button', name='Desktop connected')).to_be_visible()
        page.get_by_role('button', name='Enable camera', exact=True).click()
        expect(page.get_by_text('2 hands detected', exact=True)).to_be_visible(timeout=60000)
        with page.expect_response(lambda response: response.url.endswith('/command') and response.request.method == 'POST', timeout=30000) as command:
            page.get_by_role('button', name='Arm control', exact=True).click()
        assert command.value.status == 200
        # Wait longer than cooldown to ensure the overlapping built-in palm does
        # not emit a second command while the recorded custom pose stays held.
        page.wait_for_timeout(1900)
        page.get_by_role('button', name='Disarm', exact=True).click()
        assert companion.controller.executed == ['play_pause'], companion.controller.executed
        page.locator('nav button').filter(has_text='Activity').click()
        expect(page.locator('.activity-item').filter(has_text='Dry-run companion: no key was sent.')).to_have_count(1)
        expect(page.locator('.activity-item').filter(has_text='Integration pose').filter(has_text='Dry-run companion: no key was sent.')).to_have_count(1)
        return {'preview_recognition': True, 'custom_samples_persisted': 3, 'dry_run_commands': companion.controller.executed, 'desktop_keys_sent': False}
    finally:
        companion.shutdown()
        companion.server_close()
        thread.join(timeout=3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:5173')
    parser.add_argument('--fixture', type=Path)
    parser.add_argument('--browser', default=shutil.which('chromium'), help='Optional Chromium executable; otherwise use Playwright Chromium')
    args = parser.parse_args()
    fixture = args.fixture.read_bytes() if args.fixture else urlopen(FIXTURE_URL, timeout=30).read()
    assert fixture[:2] == b'\xff\xd8', 'The official test fixture must be a JPEG image'
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=args.browser, args=['--no-sandbox'])
        page = browser.new_page()
        page.add_init_script(FIXTURE_CAMERA)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/__vision-test-fixture.jpg', lambda route: route.fulfill(body=fixture, content_type='image/jpeg'))
        page.goto(args.url, wait_until='networkidle')
        result = page.evaluate('''async () => {
            const {createVisionTracker} = await import('/src/vision.ts');
            const image = new Image();
            image.src = '/__vision-test-fixture.jpg';
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            const stream = canvas.captureStream(15);
            const video = document.createElement('video');
            video.muted = true;
            video.playsInline = true;
            video.srcObject = stream;
            document.body.append(video);
            await video.play();
            const render = setInterval(() => context.drawImage(image, 0, 0), 66);
            let tracker;
            let frames = 0;
            let resolveResult, rejectResult;
            const detected = new Promise((resolve, reject) => {resolveResult = resolve; rejectResult = reject;});
            const timeout = setTimeout(() => rejectResult(new Error('No simultaneous hand, pose, and face detection within 25 seconds')), 25000);
            try {
                tracker = await createVisionTracker(video, frame => {
                    frames++;
                    if (frame.hands.length && frame.face?.present && frame.candidates.some(c => !c.transient && !['smile','blink','head_left','head_right'].includes(c.id))) {
                        resolveResult({
                            frames,
                            hands: frame.hands.map(hand => ({handedness: hand.handedness, label: hand.label, landmarks: hand.landmarks.length})),
                            face: {present: frame.face.present, landmarks: frame.face.landmarks.length, expression: frame.face.expression},
                            candidates: frame.candidates,
                        });
                    }
                }, {faceEnabled: true, onError: rejectResult});
                return await detected;
            } finally {
                clearTimeout(timeout);
                clearInterval(render);
                tracker?.stop();
                stream.getTracks().forEach(track => track.stop());
                video.remove();
            }
        }''')
        assert result['hands'], result
        assert all(hand['landmarks'] == 21 for hand in result['hands']), result
        assert result['face']['present'] and result['face']['landmarks'] >= 468, result
        assert any(candidate['id'] == 'open_palm' for candidate in result['candidates']), result
        assert not errors, errors
        ui = exercise_ui(page)
        assert not errors, errors
        print(json.dumps({'status': 'passed', 'fixture': FIXTURE_URL, 'result': result, 'ui': ui}, indent=2))
        browser.close()


if __name__ == '__main__':
    main()
