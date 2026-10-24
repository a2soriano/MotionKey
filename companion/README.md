# MotionKey desktop companion

The companion runs **on the computer you want to control**. Your camera stays in the browser; only command IDs such as `volume_up` cross the local connection. Commands act on the focused application or the operating system's media controls. This does not give a cloud server control of your computer.

## Run the complete app locally

Use Node.js 22.19+ (24 recommended) and Python 3.10+ in a desktop session. From the repository root:

```bash
npm ci
npm run assets
npm run build
python3 -m venv .venv
```

On macOS/Linux, activate with `source .venv/bin/activate`. On Windows PowerShell, use `.venv\Scripts\Activate.ps1` (and `python` instead of `python3` if needed).

```bash
python -m pip install -r requirements-desktop.txt
python companion/server.py --web-root dist
```

Open `http://127.0.0.1:8765`, open the desktop connection settings, and paste the pairing token printed in the companion terminal. Keep that terminal open. Start the camera and explicitly enable gesture commands when ready. Closing the companion immediately disables desktop control and invalidates the token. Restarting generates a new token; pair again.

For frontend development, run `npm run dev` in another terminal and use the same companion without `--web-root`. The default development origins on port 5173 and preview origins on port 4173 are allowed. If Vite chooses a different port, pass its exact origin explicitly, for example `--origin http://localhost:5174`. A browser may request permission to reach the local companion; allow local network access for your locally hosted MotionKey app.

## Operating-system requirements

- **Windows:** Run the companion in the same logged-in desktop session as your apps. Elevated applications may not accept input from a non-elevated companion. Windows media hotkeys are used for playback and volume.
- **macOS:** Grant your terminal (or the Python executable, if prompted) permission under System Settings → Privacy & Security → Accessibility. Relaunch it after granting permission. Media keys use native macOS system events; playback affects the current media app. Screenshots use Command+Shift+3 and follow your system screenshot settings.
- **Linux:** PyAutoGUI requires an **X11** desktop session and the XTEST extension. Wayland desktop control is not supported reliably; log in to an X11 session. Install your distribution's `python3-tk` package before installing PyAutoGUI if it is missing (`sudo apt install python3-tk` on Debian/Ubuntu). Media keys use X11 XF86 mappings and require a desktop media-key handler. Print Screen behavior follows your desktop settings.

Global keyboard automation cannot guarantee that every app consumes every shortcut. Copy/paste, undo/redo, tabs, Enter, and Escape apply to the currently focused app. The companion implements a small explicit command list; it does not run arbitrary programs, accept shell commands, or record your keyboard. Custom hand poses can be assigned to any supported command in the web app.

PyAutoGUI's emergency fail-safe remains enabled: move the mouse to a screen corner to make input fail. Stop gesture commands in MotionKey or stop the companion with Ctrl+C to disable control entirely. Keep gesture commands paused while editing mappings or entering the pairing token.

## Headless development and testing

No desktop package is required for dry-run mode:

```bash
python3 companion/server.py --dry-run --web-root dist
python3 -m unittest companion.test_server -v
```

Dry-run accepts the same authenticated API and reports `mode: "dry-run"` but **never** sends desktop input. It verifies pairing and dispatch only, and cannot validate your operating system's permissions, camera, or the behavior of media keys in desktop apps.

## Local API

- `GET /health`: `{ "ok": true, "version": "1.0.0", "mode": "desktop" | "dry-run", "authenticated": boolean, "commands": [...] }`. Include the bearer token to check whether pairing is valid.
- `GET /status`: requires `Authorization: Bearer <token>` and confirms authenticated connection/mode.
- `HEAD` supports the same health, status, and static-file routes as `GET`, with identical access checks and headers but no response body. Missing model/WASM assets return 404; WASM files use `application/wasm`.
- `POST /command`: requires the bearer token, `Content-Type: application/json`, and a body containing only `{ "command": "play_pause" }`.
- Command IDs: `play_pause`, `next_track`, `previous_track`, `volume_up`, `volume_down`, `mute`, `scroll_up`, `scroll_down`, `tab_next`, `tab_previous`, `copy`, `paste`, `undo`, `redo`, `enter`, `escape`, `screenshot`.
- Success: HTTP 200 with `{ "ok": true, "command": "play_pause", "mode": "desktop" }`. Unknown commands return 400; invalid token 401; untrusted Origin/Host 403; unsupported content type 415; body over 1024 bytes 413; commands closer than 150ms 429; desktop input failure 503.

The server binds only to IPv4 loopback (`127.0.0.1`). Host validation prevents DNS rebinding, exact Origin checks limit browser access, bearer authentication protects actions, and request size/rate limits reduce accidental repetition. Tokens are random per launch and are never embedded in frontend files. Don't expose this port through tunnels or reverse proxies, share pairing tokens, or allow untrusted origins. The optional `--origin` flag deliberately grants that origin access to the local API when it also has the token.
