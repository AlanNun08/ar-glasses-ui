const SPOTIFY_AUTHORIZE_ENDPOINT = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const NOMINATIM_SEARCH_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const OSRM_ROUTE_BASE = "https://router.project-osrm.org/route/v1";

const SESSION_COOKIE = "spotify_session_v1";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const STATE_MAX_AGE_SECONDS = 60 * 10;
const TOKEN_REFRESH_SKEW_MS = 45 * 1000;

const DEFAULT_SPOTIFY_SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
  "streaming"
].join(" ");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/" && (url.searchParams.has("code") || url.searchParams.has("error"))) {
      return handleSpotifyCallback(request, env, url);
    }

  if (url.pathname.startsWith("/api/spotify/")) {
    return handleSpotifyApi(request, env, url);
  }
  if (url.pathname.startsWith("/api/ai/")) {
    return handleAiApi(request, env, url);
  }
  if (url.pathname.startsWith("/api/youtube/")) {
    return handleYouTubeApi(request, env, url);
  }
  if (url.pathname.startsWith("/api/maps/")) {
    return handleMapsApi(request, env, url);
  }

    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      const assetResponse = await env.ASSETS.fetch(request);
      if (shouldDisableHtmlCaching(url, assetResponse)) {
        return withNoStore(assetResponse);
      }
      return assetResponse;
    }
    return new Response("ASSETS binding not configured.", { status: 500 });
  }
};

function shouldDisableHtmlCaching(url, response) {
  const contentType = response?.headers?.get("content-type") || "";
  return url.pathname === "/" || url.pathname.endsWith(".html") || contentType.includes("text/html");
}

function withNoStore(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function handleAiApi(request, env, url) {
  const { pathname } = url;
  if (pathname === "/api/ai/status" && request.method === "GET") {
    return json({
      configured: Boolean(env.OPENAI_API_KEY),
      chatModel: env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
      transcribeModel: env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
      ttsModel: env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      ttsVoice: env.OPENAI_TTS_VOICE || "coral"
    }, 200);
  }
  if (pathname === "/api/ai/chat" && request.method === "POST") {
    return handleAiChat(request, env);
  }
  if (pathname === "/api/ai/transcribe" && request.method === "POST") {
    return handleAiTranscribe(request, env);
  }
  if (pathname === "/api/ai/speak" && request.method === "POST") {
    return handleAiSpeak(request, env);
  }
  return json({ error: "Not found" }, 404);
}

function ensureOpenAiConfigured(env) {
  if (!env.OPENAI_API_KEY) {
    return json({ error: "OPENAI_API_KEY is not configured for this Worker." }, 503);
  }
  return null;
}

function buildOpenAiHeaders(env, extraHeaders = {}) {
  return {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    ...extraHeaders
  };
}

function extractOpenAiOutputText(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const chunk of content) {
      if (chunk?.type === "output_text" && typeof chunk.text === "string") {
        parts.push(chunk.text);
      } else if (chunk?.type === "refusal" && typeof chunk.refusal === "string") {
        parts.push(chunk.refusal);
      }
    }
  }
  return parts.join("").trim();
}

function buildAiResponseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["reply", "spokenReply", "command"],
    properties: {
      reply: {
        type: "string",
        description: "Short reply shown in the HUD chat."
      },
      spokenReply: {
        type: "string",
        description: "Short spoken version of the reply for voice mode."
      },
      command: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: {
            type: "string",
            enum: [
              "none",
              "widget",
              "spotify-pause",
              "spotify-resume",
              "spotify-next",
              "spotify-previous",
              "spotify-search",
              "youtube-search",
              "add",
              "remove",
              "clear",
              "edit"
            ]
          },
          widget: {
            type: "string",
            enum: ["spotify", "maps", "youtube", "reminders", "ai", "arcade"]
          },
          open: { type: "boolean" },
          query: { type: "string" },
          autoplay: { type: "boolean" },
          autoplayFirst: { type: "boolean" },
          text: { type: "string" },
          nextText: { type: "string" },
          minutes: { type: "number" }
        }
      }
    }
  };
}

function buildAiDeveloperInstructions() {
  return [
    "You are the OpenAI assistant for a futuristic walking HUD.",
    "You can answer normally, but you must also decide when the UI should trigger a widget or media action.",
    "Return JSON that matches the provided schema exactly.",
    "Keep reply and spokenReply concise.",
    "If the user wants something done in the HUD, set command.type to the best matching action.",
    "Use spotify for songs, artists, albums, or playback unless the user explicitly asks for YouTube or video.",
    "Use widget open/close for showing or hiding maps, spotify, youtube, reminders, ai, or arcade.",
    "Use add/remove/edit/clear for reminders and tasks.",
    "If no UI action is needed, set command.type to none.",
    "Do not mention schemas, JSON, or internal logic in the reply."
  ].join(" ");
}

function buildAiUserPrompt(body) {
  const message = String(body?.message || "").trim();
  const history = Array.isArray(body?.history) ? body.history.slice(-8) : [];
  const hud = body?.hud && typeof body.hud === "object" ? body.hud : {};
  const viewportMode = String(body?.viewportMode || "").trim() || "unknown";
  const voicePreferred = body?.voicePreferred === true;
  const historyLines = history
    .map((entry) => {
      const role = entry?.role === "assistant" ? "assistant" : "user";
      const content = String(entry?.content || "").trim();
      return content ? `${role}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n");

  return [
    `Viewport mode: ${viewportMode}`,
    `Voice preferred: ${voicePreferred ? "yes" : "no"}`,
    `HUD state: ${JSON.stringify(hud)}`,
    historyLines ? `Recent conversation:\n${historyLines}` : "Recent conversation: none",
    `Latest user message: ${message}`
  ].join("\n\n");
}

async function handleAiChat(request, env) {
  const missingConfig = ensureOpenAiConfigured(env);
  if (missingConfig) {
    return missingConfig;
  }

  const body = await safeReadJson(request);
  const message = String(body?.message || "").trim();
  if (!message) {
    return json({ error: "message is required." }, 400);
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: buildOpenAiHeaders(env, {
      "Content-Type": "application/json"
    }),
    body: JSON.stringify({
      model: env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
      instructions: buildAiDeveloperInstructions(),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildAiUserPrompt(body)
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "hud_ai_response",
          strict: true,
          schema: buildAiResponseSchema()
        }
      }
    })
  });

  const payload = await safeJson(response);
  if (!response.ok) {
    return json({ error: payload?.error?.message || payload?.error || `OpenAI chat failed (${response.status}).` }, response.status);
  }

  const outputText = extractOpenAiOutputText(payload);
  if (!outputText) {
    return json({ error: "OpenAI returned an empty response." }, 502);
  }

  try {
    const parsed = JSON.parse(outputText);
    return json(parsed, 200);
  } catch {
    return json({ error: "OpenAI returned invalid assistant JSON." }, 502);
  }
}

async function handleAiTranscribe(request, env) {
  const missingConfig = ensureOpenAiConfigured(env);
  if (missingConfig) {
    return missingConfig;
  }

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");
  const isFileLike = file && typeof file === "object" && typeof file.arrayBuffer === "function";
  if (!isFileLike) {
    return json({ error: "audio file is required." }, 400);
  }

  const outbound = new FormData();
  outbound.append("file", file, typeof file.name === "string" ? file.name : "voice.webm");
  outbound.append("model", env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe");
  outbound.append("response_format", "json");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: buildOpenAiHeaders(env),
    body: outbound
  });

  const payload = await safeJson(response);
  if (!response.ok) {
    return json({ error: payload?.error?.message || payload?.error || `OpenAI transcription failed (${response.status}).` }, response.status);
  }

  return json({ text: String(payload?.text || "").trim() }, 200);
}

async function handleAiSpeak(request, env) {
  const missingConfig = ensureOpenAiConfigured(env);
  if (missingConfig) {
    return missingConfig;
  }

  const body = await safeReadJson(request);
  const input = String(body?.text || "").trim();
  if (!input) {
    return json({ error: "text is required." }, 400);
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: buildOpenAiHeaders(env, {
      "Content-Type": "application/json"
    }),
    body: JSON.stringify({
      model: env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: String(body?.voice || env.OPENAI_TTS_VOICE || "coral"),
      input,
      response_format: "mp3",
      instructions: "Speak clearly, naturally, and briefly for a mobile HUD assistant."
    })
  });

  if (!response.ok) {
    const payload = await safeJson(response);
    return json({ error: payload?.error?.message || payload?.error || `OpenAI speech failed (${response.status}).` }, response.status);
  }

  const headers = new Headers({
    "Content-Type": response.headers.get("content-type") || "audio/mpeg",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  return new Response(response.body, {
    status: 200,
    headers
  });
}

async function handleYouTubeApi(request, env, url) {
  const { pathname } = url;
  if (pathname === "/api/youtube/search" && request.method === "GET") {
    return handleYouTubeSearch(env, url);
  }
  return json({ error: "Not found" }, 404);
}

async function handleMapsApi(request, env, url) {
  const { pathname } = url;
  if (pathname === "/api/maps/search" && request.method === "GET") {
    return handleMapsSearch(request, env, url);
  }
  if (pathname === "/api/maps/route" && request.method === "POST") {
    return handleMapsRoute(request, env);
  }
  return json({ error: "Not found" }, 404);
}

async function handleMapsSearch(request, env, url) {
  const query = (url.searchParams.get("q") || "").trim();
  if (query.length < 2) {
    return json({ results: [] }, 200);
  }

  const limitRaw = Number.parseInt(url.searchParams.get("limit") || "5", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 8) : 5;
  const origin = normalizeCoordinatePoint({
    lat: url.searchParams.get("lat"),
    lon: url.searchParams.get("lon")
  });
  const radiusKmRaw = Number.parseFloat(url.searchParams.get("radiusKm") || "5");
  const radiusKm = Number.isFinite(radiusKmRaw) ? Math.min(Math.max(radiusKmRaw, 2), 40) : 25;
  const fetchedLists = [];

  if (origin) {
    const localResponse = await fetchMapsSearchResults(request, env, url, {
      query,
      limit: Math.max(limit * 3, 18),
      origin,
      radiusKm,
      bounded: true
    });
    if (localResponse.error) {
      return json({ error: localResponse.error }, localResponse.status || 502);
    }
    fetchedLists.push(localResponse.results);
  }

  if (!origin || fetchedLists.flat().length < limit) {
    const fallbackResponse = await fetchMapsSearchResults(request, env, url, {
      query,
      limit: Math.max(limit * 2, 10),
      origin,
      radiusKm,
      bounded: false
    });
    if (fallbackResponse.error) {
      return json({ error: fallbackResponse.error }, fallbackResponse.status || 502);
    }
    fetchedLists.push(fallbackResponse.results);
  }

  
  const uniqueResults = dedupeMapSearchResults(fetchedLists.flat());

  // Only keep places within the requested radius.
  const results = origin
    ? uniqueResults.filter((place) =>
        Number.isFinite(place.distanceKm) &&
        place.distanceKm <= radiusKm
      )
    : uniqueResults;

  // Sort the remaining nearby places from closest to farthest.
  if (origin) {
    results.sort((a, b) => a.distanceKm - b.distanceKm);
  }

  // Return up to the requested number of results.
  return json({ results: results.slice(0, limit) }, 200);

}

async function fetchMapsSearchResults(request, env, url, options) {
  const searchUrl = new URL(typeof env.NOMINATIM_BASE_URL === "string" && env.NOMINATIM_BASE_URL.trim()
    ? `${env.NOMINATIM_BASE_URL.trim().replace(/\/+$/, "")}/search`
    : NOMINATIM_SEARCH_ENDPOINT);
  searchUrl.searchParams.set("q", options.query);
  searchUrl.searchParams.set("format", "jsonv2");
  searchUrl.searchParams.set("addressdetails", "1");
  searchUrl.searchParams.set("limit", String(options.limit));
  searchUrl.searchParams.set("dedupe", "1");

  if (options.origin) {
    const latSpan = options.radiusKm / 111;
    const lonSpan = options.radiusKm / Math.max(18, 111 * Math.cos((options.origin.lat * Math.PI) / 180));
    const west = options.origin.lon - lonSpan;
    const east = options.origin.lon + lonSpan;
    const south = options.origin.lat - latSpan;
    const north = options.origin.lat + latSpan;
    searchUrl.searchParams.set("viewbox", `${west},${north},${east},${south}`);
    if (options.bounded) {
      // Restrict the first pass to the user's local area so place-name searches
      // like "walmart" or "coffee" prefer nearby results before global matches.
      searchUrl.searchParams.set("bounded", "1");
    }
  }

  if (typeof env.NOMINATIM_EMAIL === "string" && env.NOMINATIM_EMAIL.trim()) {
    searchUrl.searchParams.set("email", env.NOMINATIM_EMAIL.trim());
  }

  const response = await fetch(searchUrl.toString(), {
    headers: buildNominatimHeaders(request, env, url)
  });
  const payload = await safeJson(response);
  if (!response.ok) {
    return {
      error: payload?.error || `Geocoding failed (${response.status}).`,
      status: response.status,
      results: []
    };
  }

  const results = Array.isArray(payload)
    ? payload
        .map((item) => normalizeMapsSearchResult(item, options.query, options.origin))
        .filter(Boolean)
    : [];

  return { results };
}

function normalizeMapsSearchResult(item, query, origin) {
  const lat = Number(item?.lat);
  const lon = Number(item?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return {
    id: String(item?.place_id || `${lat},${lon}`),
    name: String(item?.display_name || item?.name || query),
    lat,
    lon,
    type: String(item?.type || item?.class || "place"),
    address: item?.address || null,
    distanceKm: origin ? calculateDistanceKm(origin, { lat, lon }) : null
  };
}

function dedupeMapSearchResults(results) {
  const seen = new Set();
  const deduped = [];
  for (const result of results) {
    if (!result) {
      continue;
    }
    const key = `${result.id}:${result.lat}:${result.lon}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

async function handleMapsRoute(request, env) {
  const body = await safeReadJson(request);
  const origin = normalizeCoordinatePoint(body?.origin);
  const destination = normalizeCoordinatePoint(body?.destination);
  if (!origin || !destination) {
    return json({ error: "origin and destination coordinates are required." }, 400);
  }

  const configuredRouteBase = typeof env.OSRM_BASE_URL === "string" && env.OSRM_BASE_URL.trim()
    ? env.OSRM_BASE_URL.trim().replace(/\/+$/, "")
    : OSRM_ROUTE_BASE;

  // Try the configured provider first, then the public foot-routing instance.
  // Each provider has its own profile name; do not reuse a profile across hosts.
  const providers = [
    { base: configuredRouteBase, profile: "driving" },
    ...(configuredRouteBase === OSRM_ROUTE_BASE
      ? [{ base: "https://routing.openstreetmap.de/routed-foot/route/v1", profile: "driving" }]
      : [])
  ];
  let payload = null;
  let lastStatus = 502;
  let lastMessage = "No routing provider responded.";

  for (const provider of providers) {
    const routeUrl = new URL(
      `${provider.base}/${provider.profile}/${origin.lon},${origin.lat};${destination.lon},${destination.lat}`
    );
    routeUrl.searchParams.set("alternatives", "false");
    routeUrl.searchParams.set("steps", "true");
    routeUrl.searchParams.set("overview", "full");
    routeUrl.searchParams.set("geometries", "geojson");

    try {
      const response = await fetch(routeUrl.toString(), {
        headers: { Accept: "application/json" }
      });
      const candidate = await safeJson(response);
      if (response.ok && candidate?.code === "Ok") {
        payload = candidate;
        break;
      }
      lastStatus = response.status || 502;
      lastMessage = candidate?.message || candidate?.error || `Routing provider returned HTTP ${lastStatus}.`;
      // Continue to the backup after blocked/rate-limited/server-error responses.
      if (response.status !== 403 && response.status !== 429 && response.status < 500) {
        break;
      }
    } catch {
      lastStatus = 502;
      lastMessage = "Could not connect to a routing provider.";
    }
  }

  if (!payload) {
    return json({
      error: `Walking directions are temporarily unavailable (${lastStatus}). Open the destination in your maps app instead.`,
      fallbackUrl: buildAppleMapsUrl(origin, destination, false),
      webUrl: buildAppleMapsUrl(origin, destination, true)
    }, 502);
  }

  const route = Array.isArray(payload?.routes) ? payload.routes[0] : null;
  const geometry = Array.isArray(route?.geometry?.coordinates) ? route.geometry.coordinates : [];
  if (!route || geometry.length < 2) {
    return json({ error: "No walking route was returned." }, 404);
  }

  const leg = Array.isArray(route.legs) ? route.legs[0] : null;
  const steps = Array.isArray(leg?.steps) ? leg.steps : [];
  const primaryStep = summarizePrimaryStep(steps);
  const destinationName = String(body?.destination?.name || body?.destinationName || "Destination").trim() || "Destination";
  const originName = String(body?.origin?.name || body?.originName || "Current location").trim() || "Current location";

  return json({
    routeTitle: `${originName} > ${destinationName}`,
    destinationName,
    originName,
    distanceMeters: Number(route.distance || 0),
    durationSeconds: Number(route.duration || 0),
    geometry,
    primaryStep,
    openUrl: buildAppleMapsUrl(origin, destination, false),
    webUrl: buildAppleMapsUrl(origin, destination, true),
    embedUrl: buildOsmEmbedUrl(origin, destination)
  }, 200);
}

async function handleYouTubeSearch(env, url) {
  if (!env.YOUTUBE_API_KEY) {
    return json({ error: "Missing worker configuration: YOUTUBE_API_KEY" }, 500);
  }

  const query = (url.searchParams.get("q") || "").trim();
  if (query.length < 2) {
    return json({ error: "Query must be at least 2 characters." }, 400);
  }

  const limitRaw = Number.parseInt(url.searchParams.get("limit") || "5", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 10) : 5;

  const apiUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  apiUrl.searchParams.set("part", "snippet");
  apiUrl.searchParams.set("type", "video");
  apiUrl.searchParams.set("maxResults", String(limit));
  apiUrl.searchParams.set("q", query);
  apiUrl.searchParams.set("key", env.YOUTUBE_API_KEY);
  apiUrl.searchParams.set("safeSearch", "moderate");
  apiUrl.searchParams.set("videoEmbeddable", "true");

  const response = await fetch(apiUrl.toString(), {
    headers: { Accept: "application/json" }
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || "YouTube search failed.";
    return json({ error: message }, response.status);
  }

  const videos = Array.isArray(payload?.items)
    ? payload.items
        .map((item) => {
          const videoId = item?.id?.videoId;
          const snippet = item?.snippet || {};
          if (!videoId) {
            return null;
          }
          return {
            videoId,
            title: snippet.title || "YouTube",
            channel: snippet.channelTitle || "YouTube",
            thumbnail:
              snippet.thumbnails?.medium?.url ||
              snippet.thumbnails?.high?.url ||
              snippet.thumbnails?.default?.url ||
              ""
          };
        })
        .filter(Boolean)
    : [];

  return json({ videos }, 200);
}

async function handleSpotifyApi(request, env, url) {
  const { pathname } = url;
  if (pathname === "/api/spotify/login" && request.method === "GET") {
    return handleSpotifyLogin(request, env, url);
  }
  if (pathname === "/api/spotify/callback" && request.method === "GET") {
    return handleSpotifyCallback(request, env, url);
  }
  if (pathname === "/api/spotify/session" && request.method === "GET") {
    return handleSpotifySession(request, env);
  }
  if (pathname === "/api/spotify/search" && request.method === "GET") {
    return handleSpotifySearch(request, env, url);
  }
  if (pathname === "/api/spotify/player/play" && request.method === "POST") {
    return handleSpotifyPlayerCommand(request, env, "play");
  }
  if (pathname === "/api/spotify/player/token" && request.method === "GET") {
    return handleSpotifyPlayerToken(request, env);
  }
  if (pathname === "/api/spotify/player/activate" && request.method === "POST") {
    return handleSpotifyActivateDevice(request, env);
  }
  if (pathname === "/api/spotify/player/pause" && request.method === "POST") {
    return handleSpotifyPlayerCommand(request, env, "pause");
  }
  if (pathname === "/api/spotify/player/previous" && request.method === "POST") {
    return handleSpotifyPlayerCommand(request, env, "previous");
  }
  if (pathname === "/api/spotify/player/next" && request.method === "POST") {
    return handleSpotifyPlayerCommand(request, env, "next");
  }
  if (pathname === "/api/spotify/player/seek" && request.method === "POST") {
    return handleSpotifyPlayerCommand(request, env, "seek");
  }
  if (pathname === "/api/spotify/logout" && request.method === "POST") {
    return jsonWithCookies({ ok: true }, 200, [clearCookie(SESSION_COOKIE)]);
  }
  return json({ error: "Not found" }, 404);
}

function getMissingSpotifyConfig(env) {
  const missing = [];
  if (!env.SPOTIFY_CLIENT_ID) {
    missing.push("SPOTIFY_CLIENT_ID");
  }
  if (!env.SPOTIFY_CLIENT_SECRET) {
    missing.push("SPOTIFY_CLIENT_SECRET");
  }
  if (!env.SESSION_SECRET) {
    missing.push("SESSION_SECRET");
  }
  return missing;
}

function getRedirectUri(env, origin) {
  if (typeof env.SPOTIFY_REDIRECT_URI === "string" && env.SPOTIFY_REDIRECT_URI.trim()) {
    return env.SPOTIFY_REDIRECT_URI.trim();
  }
  return `${origin}/`;
}

function getScopes(env) {
  if (typeof env.SPOTIFY_SCOPES === "string" && env.SPOTIFY_SCOPES.trim()) {
    return env.SPOTIFY_SCOPES.trim();
  }
  return DEFAULT_SPOTIFY_SCOPES;
}

async function handleSpotifyLogin(request, env, url) {
  const missing = getMissingSpotifyConfig(env);
  if (missing.length > 0) {
    return json({ error: `Missing worker configuration: ${missing.join(", ")}` }, 500);
  }

  const redirectUri = getRedirectUri(env, url.origin);
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo") || "/");
  const state = await encodeSignedPayload(
    {
      nonce: randomHex(16),
      returnTo,
      createdAt: Date.now()
    },
    env.SESSION_SECRET
  );

  const authUrl = new URL(SPOTIFY_AUTHORIZE_ENDPOINT);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", env.SPOTIFY_CLIENT_ID);
  authUrl.searchParams.set("scope", getScopes(env));
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("show_dialog", "true");

  return redirectWithCookies(authUrl.toString(), []);
}

async function handleSpotifyCallback(request, env, url) {
  const missing = getMissingSpotifyConfig(env);
  if (missing.length > 0) {
    return json({ error: `Missing worker configuration: ${missing.join(", ")}` }, 500);
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return redirectWithCookies(`/?spotify_auth_error=${encodeURIComponent(oauthError)}`, []);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) {
    return redirectWithCookies("/?spotify_auth_error=missing_code", []);
  }

  let resolvedReturnTo = "/";
  let stateWarning = null;
  if (state) {
    const decodedState = await decodeSignedPayload(state, env.SESSION_SECRET);
    if (decodedState && typeof decodedState.createdAt === "number") {
      if (Date.now() - decodedState.createdAt <= STATE_MAX_AGE_SECONDS * 1000) {
        resolvedReturnTo = sanitizeReturnTo(decodedState.returnTo);
      } else {
        stateWarning = "state_expired";
      }
    } else {
      stateWarning = "state_invalid";
    }
  } else {
    stateWarning = "state_missing";
  }

  let tokenPayload;
  try {
    tokenPayload = await exchangeSpotifyCodeForToken(env, code, getRedirectUri(env, url.origin));
  } catch {
    return redirectWithCookies("/?spotify_auth_error=token_exchange_failed", []);
  }

  const session = normalizeSessionFromToken(tokenPayload, null);
  if (!session.accessToken) {
    return redirectWithCookies("/?spotify_auth_error=missing_access_token", []);
  }

  const encodedSession = await encodeSignedPayload(session, env.SESSION_SECRET);
  const redirectUrl = new URL(resolvedReturnTo, url.origin);
  redirectUrl.searchParams.set("spotify_connected", "1");
  redirectUrl.searchParams.set("app", "spotify");
  redirectUrl.searchParams.set("spotify_token", encodedSession);
  if (stateWarning) {
    redirectUrl.searchParams.set("spotify_auth_warning", stateWarning);
  }

  return redirectWithCookies(redirectUrl.toString(), [
    buildCookie(SESSION_COOKIE, encodedSession, { maxAge: SESSION_MAX_AGE_SECONDS, httpOnly: true })
  ]);
}

async function handleSpotifySession(request, env) {
  const missing = getMissingSpotifyConfig(env);
  if (missing.length > 0) {
    return json({ error: `Missing worker configuration: ${missing.join(", ")}` }, 500);
  }

  const sessionState = await getValidSpotifySession(request, env);
  if (!sessionState.session) {
    const cookies = [];
    if (sessionState.clearCookie) {
      cookies.push(clearCookie(SESSION_COOKIE));
    }
    return jsonWithCookies({ connected: false, sessionToken: null }, 200, cookies);
  }

  const cookies = [];
  if (sessionState.setCookie) {
    cookies.push(sessionState.setCookie);
  }

  const meResponse = await fetchSpotify("/me", sessionState.session.accessToken);
  if (meResponse.status === 401) {
    return jsonWithCookies({ connected: false }, 200, [clearCookie(SESSION_COOKIE)]);
  }

  let profile = null;
  if (meResponse.ok) {
    profile = await meResponse.json();
  }

  const playbackResponse = await fetchSpotify("/me/player/currently-playing", sessionState.session.accessToken);
  let playback = null;
  if (playbackResponse.status === 200) {
    playback = await playbackResponse.json();
  }

  return jsonWithCookies(
    {
      connected: true,
      profile,
      playback,
      sessionToken: sessionState.sessionToken || null
    },
    200,
    cookies
  );
}

async function handleSpotifySearch(request, env, url) {
  const missing = getMissingSpotifyConfig(env);
  if (missing.length > 0) {
    return json({ error: `Missing worker configuration: ${missing.join(", ")}` }, 500);
  }

  const query = (url.searchParams.get("q") || "").trim();
  if (query.length < 2) {
    return json({ tracks: [] }, 200);
  }
  const limit = Math.min(10, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "6", 10)));

  const sessionState = await getValidSpotifySession(request, env);
  if (!sessionState.session) {
    const cookies = [];
    if (sessionState.clearCookie) {
      cookies.push(clearCookie(SESSION_COOKIE));
    }
    return jsonWithCookies({ error: "Not connected to Spotify.", sessionToken: null }, 401, cookies);
  }

  const cookies = [];
  if (sessionState.setCookie) {
    cookies.push(sessionState.setCookie);
  }

  const searchQuery = buildSpotifyTrackSearchQuery(query);
  const searchPath = `/search?type=track&limit=${limit}&market=from_token&q=${encodeURIComponent(searchQuery)}`;
  const response = await fetchSpotify(searchPath, sessionState.session.accessToken);
  if (response.status === 401) {
    return jsonWithCookies({ error: "Spotify session expired. Reconnect required." }, 401, [clearCookie(SESSION_COOKIE)]);
  }
  if (!response.ok) {
    const payload = await safeJson(response);
    const reason = payload?.error?.message || payload?.message || `Spotify returned ${response.status}.`;
    return jsonWithCookies({ error: reason }, response.status, cookies);
  }

  const payload = await response.json();
  const tracks = Array.isArray(payload?.tracks?.items)
    ? payload.tracks.items
        .map((item) => ({
          id: item.id,
          uri: item.uri,
          name: item.name,
          artists: Array.isArray(item.artists) ? item.artists.map((artist) => artist?.name).filter(Boolean) : [],
          durationMs: Number(item.duration_ms || 0),
          album: item.album?.name || "",
          image: item.album?.images?.[2]?.url || item.album?.images?.[1]?.url || item.album?.images?.[0]?.url || "",
          explicit: item.explicit === true
        }))
        .sort((left, right) => rankSpotifyTrackResult(right, query) - rankSpotifyTrackResult(left, query))
    : [];

  return jsonWithCookies({ tracks, sessionToken: sessionState.sessionToken || null }, 200, cookies);
}

function buildSpotifyTrackSearchQuery(query) {
  const normalized = normalizeSearchText(query);
  if (!normalized) {
    return query;
  }

  const splitMatch = query.match(/^(.+?)\s+[-|:]\s+(.+)$/);
  if (splitMatch) {
    const left = splitMatch[1]?.trim();
    const right = splitMatch[2]?.trim();
    if (left && right) {
      return `track:${left} artist:${right}`;
    }
  }

  return query;
}

function rankSpotifyTrackResult(track, rawQuery) {
  const query = normalizeSearchText(rawQuery);
  const title = normalizeSearchText(track?.name);
  const artists = Array.isArray(track?.artists) ? track.artists.map(normalizeSearchText).filter(Boolean) : [];
  const album = normalizeSearchText(track?.album);
  let score = 0;

  if (!query) {
    return score;
  }
  if (title === query) {
    score += 140;
  }
  if (title.startsWith(query)) {
    score += 70;
  }
  if (title.includes(query)) {
    score += 35;
  }

  artists.forEach((artist) => {
    if (artist === query) {
      score += 60;
    } else if (artist.startsWith(query)) {
      score += 28;
    } else if (artist.includes(query)) {
      score += 16;
    }
  });

  if (album === query) {
    score += 20;
  } else if (album.includes(query)) {
    score += 8;
  }

  const splitMatch = rawQuery.match(/^(.+?)\s+[-|:]\s+(.+)$/);
  if (splitMatch) {
    const trackPart = normalizeSearchText(splitMatch[1]);
    const artistPart = normalizeSearchText(splitMatch[2]);
    if (trackPart && title.includes(trackPart)) {
      score += 45;
    }
    if (artistPart && artists.some((artist) => artist.includes(artistPart))) {
      score += 40;
    }
  }

  return score;
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function handleSpotifyPlayerToken(request, env) {
  const missing = getMissingSpotifyConfig(env);
  if (missing.length > 0) {
    return json({ error: `Missing worker configuration: ${missing.join(", ")}` }, 500);
  }

  const sessionState = await getValidSpotifySession(request, env);
  if (!sessionState.session) {
    const cookies = [];
    if (sessionState.clearCookie) {
      cookies.push(clearCookie(SESSION_COOKIE));
    }
    return jsonWithCookies({ error: "Not connected to Spotify.", sessionToken: null }, 401, cookies);
  }

  const cookies = [];
  if (sessionState.setCookie) {
    cookies.push(sessionState.setCookie);
  }

  return jsonWithCookies(
    {
      accessToken: sessionState.session.accessToken,
      expiresAt: sessionState.session.expiresAt,
      sessionToken: sessionState.sessionToken || null
    },
    200,
    cookies
  );
}

async function handleSpotifyActivateDevice(request, env) {
  const missing = getMissingSpotifyConfig(env);
  if (missing.length > 0) {
    return json({ error: `Missing worker configuration: ${missing.join(", ")}` }, 500);
  }

  const sessionState = await getValidSpotifySession(request, env);
  if (!sessionState.session) {
    const cookies = [];
    if (sessionState.clearCookie) {
      cookies.push(clearCookie(SESSION_COOKIE));
    }
    return jsonWithCookies({ error: "Not connected to Spotify.", sessionToken: null }, 401, cookies);
  }

  const body = await safeReadJson(request);
  const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
  const shouldPlay = body?.play === true;
  if (!deviceId) {
    return jsonWithCookies({ error: "deviceId is required.", sessionToken: sessionState.sessionToken || null }, 400, []);
  }

  const cookies = [];
  if (sessionState.setCookie) {
    cookies.push(sessionState.setCookie);
  }

  const response = await fetch(`${SPOTIFY_API_BASE}/me/player`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${sessionState.session.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      device_ids: [deviceId],
      play: shouldPlay
    })
  });

  if (response.status === 204) {
    return jsonWithCookies({ ok: true, sessionToken: sessionState.sessionToken || null }, 200, cookies);
  }
  if (response.status === 401) {
    return jsonWithCookies({ error: "Spotify session expired. Reconnect required." }, 401, [clearCookie(SESSION_COOKIE)]);
  }

  const payload = await safeJson(response);
  const reason = payload?.error?.message || payload?.message || `Spotify returned ${response.status}.`;
  return jsonWithCookies({ error: reason, sessionToken: sessionState.sessionToken || null }, response.status, cookies);
}

async function handleSpotifyPlayerCommand(request, env, action) {
  const missing = getMissingSpotifyConfig(env);
  if (missing.length > 0) {
    return json({ error: `Missing worker configuration: ${missing.join(", ")}` }, 500);
  }

  const sessionState = await getValidSpotifySession(request, env);
  if (!sessionState.session) {
    const cookies = [];
    if (sessionState.clearCookie) {
      cookies.push(clearCookie(SESSION_COOKIE));
    }
    return jsonWithCookies({ error: "Not connected to Spotify.", sessionToken: null }, 401, cookies);
  }

  const cookies = [];
  if (sessionState.setCookie) {
    cookies.push(sessionState.setCookie);
  }

  const mapping = {
    play: { method: "PUT", path: "/me/player/play" },
    pause: { method: "PUT", path: "/me/player/pause" },
    previous: { method: "POST", path: "/me/player/previous" },
    seek: { method: "PUT", path: "/me/player/seek" },
    next: { method: "POST", path: "/me/player/next" }
  };
  const route = mapping[action];
  if (!route) {
    return json({ error: "Unsupported command." }, 400);
  }

  let body;
  let routePath = route.path;
  let preferredDeviceId = null;
  if (action === "play") {
    const maybeJson = await safeReadJson(request);
    if (typeof maybeJson?.uri === "string" && maybeJson.uri.trim()) {
      body = JSON.stringify({ uris: [maybeJson.uri.trim()] });
    } else if (Array.isArray(maybeJson?.uris) && maybeJson.uris.length > 0) {
      body = JSON.stringify({ uris: maybeJson.uris.slice(0, 20) });
    }
    if (typeof maybeJson?.deviceId === "string" && maybeJson.deviceId.trim()) {
      preferredDeviceId = maybeJson.deviceId.trim();
    }
  } else if (action === "seek") {
    const maybeJson = await safeReadJson(request);
    const positionMs = Number(maybeJson?.positionMs);
    if (!Number.isFinite(positionMs) || positionMs < 0) {
      return jsonWithCookies({ error: "positionMs is required for seek." }, 400, cookies);
    }
    routePath = `${route.path}?position_ms=${Math.floor(positionMs)}`;
  }

  const doPlayerRequest = async (deviceId = null) => {
    const hasQuery = routePath.includes("?");
    const withDevice = deviceId
      ? `${routePath}${hasQuery ? "&" : "?"}device_id=${encodeURIComponent(deviceId)}`
      : routePath;
    return fetch(`${SPOTIFY_API_BASE}${withDevice}`, {
      method: route.method,
      headers: {
        Authorization: `Bearer ${sessionState.session.accessToken}`,
        "Content-Type": "application/json"
      },
      body
    });
  };

  let response = await doPlayerRequest(preferredDeviceId);
  if (response.status === 404) {
    const activeDevice = await ensureSpotifyActiveDevice(sessionState.session.accessToken);
    if (activeDevice?.id) {
      response = await doPlayerRequest(activeDevice.id);
    }
  }

  if (response.status === 401) {
    return jsonWithCookies({ error: "Spotify session expired. Reconnect required." }, 401, [clearCookie(SESSION_COOKIE)]);
  }

  if (response.status === 204) {
    return jsonWithCookies({ ok: true, sessionToken: sessionState.sessionToken || null }, 200, cookies);
  }

  const payload = await safeJson(response);
  if (response.status === 404) {
    return jsonWithCookies(
      {
        error: "No active Spotify device. Open Spotify app on your phone and start a track first."
      },
      409,
      cookies
    );
  }
  if (response.status === 403) {
    return jsonWithCookies(
      {
        error: "Spotify Premium is required for playback control."
      },
      403,
      cookies
    );
  }

  const reason = payload?.error?.message || payload?.message || `Spotify returned ${response.status}.`;
  return jsonWithCookies({ error: reason }, response.status, cookies);
}

async function getValidSpotifySession(request, env) {
  const headerToken = request.headers.get("X-Spotify-Session");
  const cookieMap = parseCookies(request.headers.get("Cookie") || "");
  const cookieToken = cookieMap[SESSION_COOKIE];
  const raw = typeof headerToken === "string" && headerToken.trim() ? headerToken.trim() : cookieToken;
  const usedCookie = !headerToken || !headerToken.trim();
  if (!raw) {
    return { session: null, clearCookie: false, setCookie: null, sessionToken: null };
  }

  const session = await decodeSignedPayload(raw, env.SESSION_SECRET);
  if (!session || typeof session !== "object" || !session.accessToken) {
    return { session: null, clearCookie: usedCookie, setCookie: null, sessionToken: null };
  }

  const expiresAt = Number(session.expiresAt || 0);
  if (expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return { session, clearCookie: false, setCookie: null, sessionToken: raw };
  }

  if (!session.refreshToken) {
    return { session: null, clearCookie: usedCookie, setCookie: null, sessionToken: null };
  }

  try {
    const refreshPayload = await refreshSpotifyToken(env, session.refreshToken);
    const refreshed = normalizeSessionFromToken(refreshPayload, session);
    const encoded = await encodeSignedPayload(refreshed, env.SESSION_SECRET);
    return {
      session: refreshed,
      clearCookie: false,
      setCookie: buildCookie(SESSION_COOKIE, encoded, { maxAge: SESSION_MAX_AGE_SECONDS, httpOnly: true }),
      sessionToken: encoded
    };
  } catch {
    return { session: null, clearCookie: usedCookie, setCookie: null, sessionToken: null };
  }
}

async function exchangeSpotifyCodeForToken(env, code, redirectUri) {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  body.set("client_id", env.SPOTIFY_CLIENT_ID);
  body.set("client_secret", env.SPOTIFY_CLIENT_SECRET);

  const response = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  if (!response.ok) {
    throw new Error("Token exchange failed.");
  }
  return response.json();
}

async function refreshSpotifyToken(env, refreshToken) {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("client_id", env.SPOTIFY_CLIENT_ID);
  body.set("client_secret", env.SPOTIFY_CLIENT_SECRET);

  const response = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  if (!response.ok) {
    throw new Error("Token refresh failed.");
  }
  return response.json();
}

function normalizeSessionFromToken(tokenPayload, previousSession) {
  return {
    accessToken: String(tokenPayload?.access_token || ""),
    refreshToken: String(tokenPayload?.refresh_token || previousSession?.refreshToken || ""),
    tokenType: String(tokenPayload?.token_type || previousSession?.tokenType || "Bearer"),
    scope: String(tokenPayload?.scope || previousSession?.scope || ""),
    expiresAt: Date.now() + Number(tokenPayload?.expires_in || 3600) * 1000
  };
}

async function fetchSpotify(path, accessToken) {
  return fetch(`${SPOTIFY_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

async function fetchSpotifyDevices(accessToken) {
  const response = await fetchSpotify("/me/player/devices", accessToken);
  if (!response.ok) {
    return [];
  }
  const payload = await safeJson(response);
  return Array.isArray(payload?.devices) ? payload.devices : [];
}

async function ensureSpotifyActiveDevice(accessToken) {
  const devices = await fetchSpotifyDevices(accessToken);
  if (!devices.length) {
    return null;
  }
  const candidate =
    devices.find((item) => item && item.is_active === true && item.is_restricted !== true)
    || devices.find((item) => item && item.is_restricted !== true)
    || devices.find((item) => item && item.id);

  if (!candidate?.id) {
    return null;
  }

  try {
    await fetch(`${SPOTIFY_API_BASE}/me/player`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        device_ids: [candidate.id],
        play: false
      })
    });
  } catch {
    // best effort
  }
  return candidate;
}

function normalizeCoordinatePoint(input) {
  const lat = Number(input?.lat);
  const lon = Number(input?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return {
    lat: clampCoordinate(lat, -90, 90),
    lon: clampCoordinate(lon, -180, 180),
    name: typeof input?.name === "string" ? input.name.trim() : ""
  };
}

function clampCoordinate(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildRoutingUserAgent(env, origin) {
  const appName = typeof env.ROUTING_APP_NAME === "string" && env.ROUTING_APP_NAME.trim()
    ? env.ROUTING_APP_NAME.trim()
    : "ar-walking-hud-sample";
  return `${appName}/1.0 (${origin})`;
}

function buildNominatimHeaders(request, env, url) {
  const headers = new Headers({
    Accept: "application/json",
    "Accept-Language": request.headers.get("Accept-Language") || "en",
    "User-Agent": buildRoutingUserAgent(env, url.origin)
  });
  const referer = request.headers.get("Origin") || request.headers.get("Referer") || url.origin;
  if (referer) {
    headers.set("Referer", referer);
  }
  return headers;
}

function summarizePrimaryStep(steps) {
  const candidate = steps.find((step) => step?.maneuver?.type && step.maneuver.type !== "depart")
    || steps.find((step) => step?.maneuver?.type)
    || null;
  if (!candidate) {
    return {
      title: "Continue on route",
      detail: "Follow the highlighted walking route.",
      arrow: "↑"
    };
  }

  const modifier = String(candidate?.maneuver?.modifier || "").toLowerCase();
  const type = String(candidate?.maneuver?.type || "").toLowerCase();
  const directionLabel = formatDirectionInstruction(modifier, type);
  const detailDistance = Number.isFinite(Number(candidate?.distance))
    ? formatRouteStepDistance(Number(candidate.distance))
    : "";
  const detail = formatDirectionDetail(directionLabel, detailDistance, type);

  return {
    title: directionLabel,
    detail,
    arrow: directionArrowForModifier(modifier, type)
  };
}

function formatRouteStepDistance(distanceMeters) {
  if (!Number.isFinite(distanceMeters)) {
    return "ahead";
  }
  const miles = distanceMeters / 1609.344;
  if (miles < 0.2) {
    return `${Math.max(50, Math.round(miles * 5280))} ft`;
  }
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

function formatDirectionInstruction(modifier, type) {
  if (type === "arrive") {
    return "Arrive at destination";
  }
  if (type === "depart") {
    return "Keep straight";
  }
  if (modifier === "slight right") {
    return "Make a right";
  }
  if (modifier === "right") {
    return "Make a right";
  }
  if (modifier === "sharp right") {
    return "Make a right";
  }
  if (modifier === "slight left") {
    return "Take a left";
  }
  if (modifier === "left") {
    return "Take a left";
  }
  if (modifier === "sharp left") {
    return "Take a left";
  }
  if (modifier === "uturn") {
    return "Make a U-turn";
  }
  return "Keep straight";
}

function formatDirectionDetail(instruction, distanceLabel, type) {
  if (type === "arrive") {
    return "Arrive at destination";
  }
  if (!distanceLabel) {
    return instruction;
  }
  if (instruction === "Keep straight") {
    return `${instruction} for ${distanceLabel}`;
  }
  return `${instruction} in ${distanceLabel}`;
}

function directionArrowForModifier(modifier, type) {
  if (type === "arrive") {
    return "•";
  }
  if (modifier === "slight right") {
    return "↗";
  }
  if (modifier === "right") {
    return "→";
  }
  if (modifier === "sharp right") {
    return "↘";
  }
  if (modifier === "slight left") {
    return "↖";
  }
  if (modifier === "left") {
    return "←";
  }
  if (modifier === "sharp left") {
    return "↙";
  }
  if (modifier === "uturn") {
    return "↺";
  }
  return "↑";
}

function buildAppleMapsUrl(origin, destination, web = false) {
  const params = new URLSearchParams();
  params.set("saddr", `${origin.lat},${origin.lon}`);
  params.set("daddr", `${destination.lat},${destination.lon}`);
  params.set("dirflg", "w");
  if (web) {
    return `https://maps.apple.com/?${params.toString()}`;
  }
  return `maps://?${params.toString()}`;
}

function calculateDistanceKm(origin, target) {
  const lat1 = Number(origin?.lat);
  const lon1 = Number(origin?.lon);
  const lat2 = Number(target?.lat);
  const lon2 = Number(target?.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) {
    return Number.POSITIVE_INFINITY;
  }

  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  return 6371 * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function buildOsmEmbedUrl(origin, destination) {
  const minLon = Math.min(origin.lon, destination.lon);
  const maxLon = Math.max(origin.lon, destination.lon);
  const minLat = Math.min(origin.lat, destination.lat);
  const maxLat = Math.max(origin.lat, destination.lat);
  const padLon = Math.max(0.01, (maxLon - minLon) * 0.45);
  const padLat = Math.max(0.01, (maxLat - minLat) * 0.45);
  const bbox = [
    (minLon - padLon).toFixed(6),
    (minLat - padLat).toFixed(6),
    (maxLon + padLon).toFixed(6),
    (maxLat + padLat).toFixed(6)
  ].join("%2C");
  const markerLat = destination.lat.toFixed(6);
  const markerLon = destination.lon.toFixed(6);
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${markerLat}%2C${markerLon}`;
}

function parseCookies(rawCookieHeader) {
  const out = {};
  if (!rawCookieHeader) {
    return out;
  }
  rawCookieHeader.split(";").forEach((part) => {
    const splitAt = part.indexOf("=");
    if (splitAt <= 0) {
      return;
    }
    const key = part.slice(0, splitAt).trim();
    const value = part.slice(splitAt + 1).trim();
    out[key] = value;
  });
  return out;
}

function buildCookie(name, value, options = {}) {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path || "/"}`);
  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  if (options.secure !== false) {
    parts.push("Secure");
  }
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  return parts.join("; ");
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`;
}

function sanitizeReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    return "/";
  }
  if (value.startsWith("//")) {
    return "/";
  }
  return value;
}

function randomHex(bytes = 16) {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array, (entry) => entry.toString(16).padStart(2, "0")).join("");
}

async function encodeSignedPayload(payload, secret) {
  const json = JSON.stringify(payload);
  const encoded = bytesToBase64Url(encoder.encode(json));
  const signature = await signString(encoded, secret);
  return `${encoded}.${signature}`;
}

async function decodeSignedPayload(value, secret) {
  if (typeof value !== "string") {
    return null;
  }
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) {
    return null;
  }
  const expected = await signString(encoded, secret);
  if (!constantTimeEqual(signature, expected)) {
    return null;
  }
  try {
    const bytes = base64UrlToBytes(encoded);
    const text = decoder.decode(bytes);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function signString(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signatureBuffer));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    const slice = bytes.subarray(i, i + 0x8000);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4 || 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function json(payload, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(JSON.stringify(payload), { status, headers });
}

function jsonWithCookies(payload, status = 200, cookies = []) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  cookies.forEach((cookie) => {
    if (cookie) {
      headers.append("Set-Cookie", cookie);
    }
  });
  return new Response(JSON.stringify(payload), { status, headers });
}

function redirectWithCookies(location, cookies = []) {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store"
  });
  cookies.forEach((cookie) => {
    if (cookie) {
      headers.append("Set-Cookie", cookie);
    }
  });
  return new Response(null, { status: 302, headers });
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function safeReadJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
