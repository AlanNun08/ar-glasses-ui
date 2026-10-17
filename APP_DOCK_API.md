# App Dock API (Web Mode)

The web HUD can load dock apps from an API endpoint.

## Use

Add query param:

- `?appApi=https://your-domain.com/hud-apps.json`

Optional default app:

- `?app=maps`

Example combined:

- `https://ar-walking-hud-sample.npmnorth.workers.dev/?appApi=https://example.com/hud-apps.json&app=youtube`

## Response shape

```json
{
  "apps": [
    {
      "id": "spotify",
      "label": "Spotify",
      "title": "Spotify Player",
      "subtitle": "Music stream",
      "embedUrl": "https://open.spotify.com/embed/track/11dFghVXANMlKmJXsNCbNl?utm_source=generator&theme=0",
      "openUrl": "spotify:track:11dFghVXANMlKmJXsNCbNl",
      "webUrl": "https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl",
      "hint": "Tap play once to start audio playback."
    },
    {
      "id": "maps",
      "label": "Maps",
      "title": "Map View",
      "subtitle": "Directions widget",
      "embedUrl": "https://www.openstreetmap.org/export/embed.html?bbox=-122.4313%2C37.7682%2C-122.4013%2C37.7882&layer=mapnik&marker=37.7782%2C-122.4163",
      "openUrl": "maps://?q=Market+Street+San+Francisco",
      "webUrl": "https://maps.apple.com/?q=Market+Street+San+Francisco",
      "hint": "Pan/zoom map inside widget or open native maps."
    }
  ]
}
```

## Notes

- `apps` is optional. If missing/invalid, built-in defaults are used.
- Keep `embedUrl` to providers that allow iframe embedding.
- On iPhone, autoplay is gesture-gated, so users may need one tap in the player.
