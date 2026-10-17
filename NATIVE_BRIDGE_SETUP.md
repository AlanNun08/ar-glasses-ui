# HUD Dual Mode: Web + Native

This HUD now supports both modes:

- `web` mode: uses browser APIs where available.
- `native` mode: accepts real phone data from an iOS wrapper.

## Test URLs

- Auto mode (default):
  - `https://ar-walking-hud-sample.npmnorth.workers.dev`
- Force web mode:
  - `https://ar-walking-hud-sample.npmnorth.workers.dev/?mode=web`
- Force native mode (waiting for native app updates):
  - `https://ar-walking-hud-sample.npmnorth.workers.dev/?mode=native`
- Native simulator mode (for solo testing in browser):
  - `https://ar-walking-hud-sample.npmnorth.workers.dev/?mode=native&nativeSim=1`
- Spotify track override (supports Spotify URL or URI):
  - `https://ar-walking-hud-sample.npmnorth.workers.dev/?spotify=spotify:track:11dFghVXANMlKmJXsNCbNl`

## JavaScript Bridge Contract

The page exposes `window.HUDNativeBridge`:

- `HUDNativeBridge.update(payload)`
- `HUDNativeBridge.setMode("native" | "web")`
- `HUDNativeBridge.getState()`

Expected payload fields (all optional):

```json
{
  "batteryPct": 82,
  "isCharging": false,
  "networkType": "5G",
  "signalBars": 4,
  "carrier": "T-Mobile",
  "timeText": "03:21 PM"
}
```

## iOS WKWebView Real Bridge

Use the real native files in:

- `ios/HudBridgeApp/AppDelegate.swift`
- `ios/HudBridgeApp/SceneDelegate.swift`
- `ios/HudBridgeApp/HudBridgeViewController.swift`
- `ios/HudBridgeApp/README.md`

## Notes

- In iPhone Safari (plain web), battery and carrier details are usually unavailable.
- In native mode, the bridge now sends real battery and network type.
- iOS does not expose exact signal bars through public APIs, so `signalBars` is `null` by default.
