# MotionKey

A private, camera-powered gesture controller for your computer. Recognize hand poses, directional swipes, smiles, and head turns; map them to desktop commands; and record your own static hand poses.

## Run on your computer

Requirements: **Node.js 22.19+** (24 recommended), **Python 3.10+**, a webcam, and a desktop session. Windows, macOS, and Linux X11 are supported by the companion. Wayland desktop input is not supported.

```bash
npm ci
npm run assets
npm run build
python -m venv .venv
```

Activate the Python environment:

```bash
# macOS / Linux
source .venv/bin/activate

# Windows PowerShell
.venv\Scripts\Activate.ps1
```

Then:

```bash
python -m pip install -r requirements-desktop.txt
python companion/server.py --web-root dist
```

Open `http://127.0.0.1:8765` on the **same computer**. Keep the terminal running. In MotionKey, choose **Connect desktop** and paste the pairing token printed by the companion. Tokens change each time the companion restarts and are stored only in the browser tab's session storage.

On macOS, allow Accessibility access for the terminal/Python process in System Settings. On Linux, use an X11 session; additional packages may be required. See [desktop companion instructions](companion/README.md) for platform requirements and troubleshooting.

The `assets` step downloads official MediaPipe models from `storage.googleapis.com`, copies the installed MediaPipe WASM runtime into `public/`, and records SHA-256 digests to verify its local cache on subsequent runs. HTTPS verification stays enabled, and environment HTTP(S) proxies are supported. Model and WASM binaries are generated/ignored; run this step after a fresh clone or dependency update, before building. The app and fonts are served locally; after assets are prepared, tracking needs no network service.

## Use it

1. Enable the camera in **Gesture studio**. Camera frames stay in the browser.
2. Try an **open palm**, **peace sign**, or **thumbs up**. Recognition appears in the preview and Activity even without a companion connection.
3. Click a gesture to change its command. Enable more poses, swipes, or face expressions in **My gestures**. Face tracking recognizes expressions and head movement, not a person's identity. Face gestures start disabled.
4. To teach a pose, choose **Create gesture** while the studio camera is running. Capture at least three examples of the same pose at slightly different angles, give it a name, and assign a command. Custom gestures are **static poses**, not arbitrary motion sequences. Built-in left/right swipes provide motion recognition.
5. Pair the desktop companion, then click **Arm control**. Commands go to the application currently in focus, not necessarily the browser. Hold a pose for the configured time, then release it before repeating. Short swipe events trigger immediately. Natural eye blinks may trigger the optional **Close eyes** mapping; enable it deliberately.
6. **Disarm**, pause recognition, or stop the camera to stop sending commands. Leaving the studio stops the camera and disarms control. Adjust hold time, command cooldown, and tracking overlays in Settings. Change face tracking while the camera is stopped.

When a custom pose also matches a built-in gesture, the custom pose takes priority; a held gesture cannot cascade into multiple commands.

Mappings, settings, and custom hand coordinates are stored in this browser's local storage. **Export profile** downloads a JSON backup (import is not implemented). Activity is limited to the latest 100 events and resets on reload. No accounts, recordings, face identification, or cloud video processing are used.

### Desktop commands

Play/pause, next/previous track, volume up/down, mute, scroll up/down, next/previous tab, copy/paste, undo/redo, Enter, Escape, and screenshot. Keyboard/media-key behavior depends on the operating system and focused application's support. This app does not run arbitrary shell commands or permit arbitrary remote access.

Use preview mode first. Keep dangerous or sensitive apps out of focus while trying new mappings. PyAutoGUI's emergency fail-safe remains enabled: moving the pointer to a screen corner blocks input. Recognition isn't guaranteed for every pose, lighting condition, occlusion, or hand orientation. Browsers can throttle tracking when the tab is hidden; keep MotionKey visible, for example on a second monitor.

## Development

Use this checkout directly; cloud tasks already have an isolated workspace.

```bash
npm ci
npm run assets
npm run dev
```

Vite serves the development app on port 5173. For desktop integration, run the companion in a second terminal on your computer:

```bash
python companion/server.py
```

The companion accepts the default localhost/127.0.0.1 Vite origins. For a different frontend origin, explicitly allow it with `--origin`. Prefer serving the production build through the companion to avoid mixed-content or local-network browser restrictions. Camera access requires localhost or HTTPS. A remote/cloud app cannot control your desktop without the companion on your computer.

### Headless / cloud testing

```bash
npm test
npm run test:desktop
npm run build
python companion/server.py --dry-run --web-root dist
```

Dry-run mode exercises pairing and command dispatch **without generating desktop input**. The UI clearly labels dry-run connections and records their actions as preview events. Camera inference still requires the model assets and a real/fake video source. Neither dry-run tests nor a successful build establishes that a user's webcam, OS permissions, or physical desktop input works.

The optional end-to-end UI smoke test requires Python Playwright and Chromium plus a running Vite server:

```bash
python tests/ui_smoke.py
python tests/vision_browser.py
```

The UI suite checks real model initialization through Chromium’s synthetic webcam. The vision suite downloads an official MediaPipe test photo over HTTPS (or accepts `--fixture /path/to/photo.jpg`), feeds it through a real video stream, and checks actual hand/face inference, preview events, custom-pose persistence, and authenticated dry-run dispatch. Run the suites one at a time: each temporarily uses companion port 8765. For browser-test prerequisites, install Python Playwright and its Chromium browser, or set `CHROMIUM_PATH` for the UI suite / `--browser` for the vision suite to your system Chromium executable.

## Project layout

- `src/App.tsx` — gesture studio, settings, custom-pose capture, pairing, activity
- `src/vision.ts` — real MediaPipe hand/face landmark inference and gesture classification
- `src/domain.ts` — mappings, persistence, and gesture hold/release/cooldown gate
- `src/bridge.ts` — authenticated loopback companion client
- `companion/server.py` — allowlisted OS input, authenticated API, production frontend serving
- `scripts/prepare-assets.mjs` — repeatable local model and runtime preparation

The desktop companion binds to loopback only, checks Host and Origin headers, authenticates commands with a per-launch token, bounds request sizes, and rate-limits commands. See its README for details.
