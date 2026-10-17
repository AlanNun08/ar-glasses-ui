#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const https = require("https");

const PORT = Number.parseInt(process.env.OLLAMA_HTTPS_PORT || "11435", 10);
const OLLAMA_HOST = process.env.OLLAMA_HOST || "127.0.0.1";
const OLLAMA_PORT = Number.parseInt(process.env.OLLAMA_PORT || "11434", 10);
const CERT_PATH = process.env.OLLAMA_HTTPS_CERT || "./local-certs/localhost.pem";
const KEY_PATH = process.env.OLLAMA_HTTPS_KEY || "./local-certs/localhost-key.pem";
const ALLOWED_ORIGINS = new Set([
  "https://ar-walking-hud-sample.npmnorth.workers.dev",
  "https://localhost:8000",
  "http://localhost:8000",
  "https://127.0.0.1:8000",
  "http://127.0.0.1:8000"
]);

function buildCorsHeaders(origin) {
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://ar-walking-hud-sample.npmnorth.workers.dev";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function sendJson(res, statusCode, payload, corsHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders
  });
  res.end(JSON.stringify(payload));
}

function proxyRequest(req, res) {
  const corsHeaders = buildCorsHeaders(req.headers.origin);
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (!req.url.startsWith("/api/")) {
    sendJson(res, 404, { error: "Not found" }, corsHeaders);
    return;
  }

  const upstream = http.request(
    {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${OLLAMA_HOST}:${OLLAMA_PORT}`,
        origin: `http://${OLLAMA_HOST}:${OLLAMA_PORT}`
      }
    },
    (upstreamRes) => {
      const headers = {
        ...corsHeaders,
        "Cache-Control": "no-store"
      };
      const contentType = upstreamRes.headers["content-type"];
      if (contentType) {
        headers["Content-Type"] = contentType;
      }
      res.writeHead(upstreamRes.statusCode || 502, headers);
      upstreamRes.pipe(res);
    }
  );

  upstream.on("error", (error) => {
    sendJson(res, 502, { error: error.message || "Upstream request failed." }, corsHeaders);
  });

  req.pipe(upstream);
}

const server = https.createServer(
  {
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH)
  },
  proxyRequest
);

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`Ollama HTTPS bridge listening on https://localhost:${PORT}\n`);
});
