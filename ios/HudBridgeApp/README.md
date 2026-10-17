# iOS Native HUD Bridge (Real Battery + Network)

This folder contains native Swift source files that push real iPhone status to the web HUD.

## What is real

- Battery percent + charging state via `UIDevice`.
- Network type (WiFi / Cellular / Offline) via `NWPathMonitor`.
- Cellular generation (2G/3G/4G/5G) via `CoreTelephony` radio access tech.
- Carrier name via `CoreTelephony`.

## Public API limits

- Exact iOS signal bars are not available through public APIs.
- This bridge sends `signalBars: null` by design.

## Quick Setup in Xcode

1. Create a new iOS App project (UIKit App Delegate lifecycle).
2. Add these files to the app target:
   - `AppDelegate.swift`
   - `SceneDelegate.swift`
   - `HudBridgeViewController.swift`
3. Ensure deployment target supports:
   - `Network.framework`
   - `CoreTelephony.framework`
4. Run on iPhone.

The app loads:

- `https://ar-walking-hud-sample.npmnorth.workers.dev/?mode=native`

and continuously calls:

- `window.HUDNativeBridge.update(...)`

inside the webpage.
