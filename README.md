# AR Glasses HUD

A web-based augmented-reality (AR) glasses interface that explores how everyday digital tools could work in a lightweight, glanceable heads-up display. The intention is to make useful information and controls available in a spatial interface—without needing to constantly look down at a phone.

This project is a prototype and experimentation space for smart-glasses UI, walking navigation, voice interaction, and floating widgets. It can run in a desktop or mobile browser and is designed with future smart-glasses integration in mind; it is not, by itself, a production native AR application.

## Project intention

The goal is to explore a practical, customizable HUD for walking and daily use:

- Keep key tools in small, movable widgets that can be arranged around the screen.
- Make navigation and destination information easy to glance at while moving.
- Bring music, video search, reminders, and an AI voice assistant into one interface.
- Experiment with hands-free and voice-first interaction, compact controls, and different screen/device layouts.
- Provide a foundation that can later be adapted to compatible AR glasses or a native companion app.

## What the website does

### HUD and widgets

The page presents a futuristic, glass-style interface with configurable widgets and an app dock. Widget layout and display modes are intended to make the interface usable across different screen sizes and portrait/landscape setups.

### Maps and walking navigation

- Uses the browser's location permission to determine the user's current position.
- Searches for nearby places using OpenStreetMap's Nominatim service.
- Includes suggested route presets that can be selected in the Maps widget.
- Lets a user search for a destination and request a route from their current location.
- Draws returned route geometry in the widget and presents route details such as distance, estimated travel time, and navigation instructions when routing data is available.
- Tries a public Valhalla pedestrian-routing endpoint for searched destinations, with public OSRM-based routing services as backups. Public services can be rate-limited, unavailable, or reject requests; in that case, a generated in-widget route may not be available.

The route line is rendered by the website's map UI. Location access must be granted for routes starting at the user's current position. Location accuracy and route availability depend on the device, browser, mapping data, and external services.

### Music and video

- Spotify sign-in and playback features use Spotify's API and require the appropriate Spotify developer credentials and account permissions.
- YouTube search is provided through the backend and requires a configured YouTube API key.
- Apple Music links and previews provide another music discovery path where supported.

### AI voice assistant

The assistant can use backend endpoints for chat, speech transcription, and text-to-speech. These features require an OpenAI API key configured as a Cloudflare Worker secret. The configured models and voice can be set through Worker environment variables.

### Reminders and arcade

The interface includes reminders and a small arcade/game experience to explore how simple daily utilities and lightweight entertainment could fit into a glasses HUD.

## How it works

The project has two main parts:

- **`public/index.html`** — the browser interface: visual styling, widget layout, Maps rendering, user interactions, local UI state, reminders, and client-side calls to the backend.
- **`worker.js`** — a Cloudflare Worker that serves as the backend API for Maps search/routing, Spotify integration, YouTube search, and AI chat/audio endpoints.
- **`wrangler.toml`** — Cloudflare Workers configuration, including the static asset directory and non-secret environment variables.

Typical flow for a searched destination:

1. The browser asks for location permission and obtains the current coordinates.
2. The user searches for a place; the frontend requests nearby results from `/api/maps/search`.
3. Selecting a result sends the origin and destination to `/api/maps/route`.
4. The Worker requests a pedestrian route from a public routing service and returns route geometry and instructions when successful.
5. The frontend converts the response into the Maps widget's route model and uses the existing map-rendering functions to draw it and update route details.

Suggested routes are predefined in the frontend; searched destinations require live routing data. This is why suggested routes can work even when a public routing service for a searched destination is unavailable.

## Technology

- HTML, CSS, and JavaScript
- Leaflet for the interactive map
- Cloudflare Workers and Wrangler
- OpenStreetMap Nominatim for place search
- Public Valhalla/OSRM routing services for route calculations
- Spotify API
- YouTube Data API (when configured)
- OpenAI API for chat, transcription, and speech generation (when configured)

## Run locally and deploy

Requirements: Node.js/npm and a Cloudflare account with access to the configured Worker.

1. Clone the repository and enter the project directory.
2. Install/use Wrangler through `npx` if it is not already available.
3. Configure the required secrets for the features you intend to use.
4. Test locally with Wrangler if desired.
5. Deploy the Worker and static assets with:

```bash
npx wrangler deploy
```

For an existing local checkout, pull the latest changes first:

```bash
git pull --ff-only origin main
npx wrangler deploy
```

## Configuration and secrets

Do not commit API secrets to GitHub or place them in frontend code. Configure secrets with Wrangler, for example:

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put YOUTUBE_API_KEY
```

Spotify also requires a Spotify app/client ID and a redirect URI that matches the deployed application URL. Review `wrangler.toml` for non-secret configuration values and keep private keys in Worker secrets.

Some features can be explored without configuring every integration, but Spotify playback, AI services, and YouTube search require their respective credentials. Public map search/routing services do not require your own API key, but their public endpoints have usage policies and are not guaranteed to be continuously available.

## Current limitations

- This is a prototype, not a certified safety or navigation product.
- Public routing endpoints may be blocked, rate-limited, or temporarily unavailable.
- The browser needs location permission for navigation from the current position.
- Music, video, and AI integrations depend on third-party accounts, credentials, service availability, and their terms of use.
- A web HUD is not automatically rendered as a native optical overlay on every pair of AR glasses; actual hardware support may require a compatible browser, bridge, or native app.

## Safety note

Use this as an experimental interface. Do not rely on it as your sole navigation source while walking, cycling, or driving, and remain aware of your surroundings.

## Repository

Source code: https://github.com/AlanNun08/ar-glasses-ui
