import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, fetchMatches, getApiKey, loadEnv, validateQuery } from './lib/henrik.js';

loadEnv();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

function cacheKey(query) {
  return [query.name.toLowerCase(), query.tag.toLowerCase(), query.region, query.platform, query.count].join('|');
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.payload;
}

function setCached(key, payload) {
  if (cache.size >= 40) cache.delete(cache.keys().next().value);
  cache.set(key, { expires: Date.now() + CACHE_TTL, payload });
}

async function serveStatic(response, pathname) {
  const requested = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(response, 403, { error: 'Access denied.' });
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: 'File not found.' });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }

  if (url.pathname === '/api/config') {
    sendJson(response, 200, { configured: Boolean(getApiKey()) });
    return;
  }

  if (url.pathname === '/api/matches') {
    const raw = Object.fromEntries(url.searchParams);
    const validation = validateQuery(raw);
    if (validation.error) {
      sendJson(response, 400, { error: validation.error });
      return;
    }

    const query = validation.value;
    const key = cacheKey(query);
    if (url.searchParams.get('refresh') === '1') cache.delete(key);
    const cached = getCached(key);
    if (cached) {
      sendJson(response, 200, { ...cached, cached: true });
      return;
    }

    try {
      const payload = await fetchMatches(query);
      setCached(key, payload);
      sendJson(response, 200, { ...payload, cached: false });
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      console.error('Unexpected error:', error);
      sendJson(response, 500, { error: 'Internal server error.' });
    }
    return;
  }

  await serveStatic(response, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Valorant Tracker: http://localhost:${PORT}`);
  if (!getApiKey()) console.log('API key missing: copy .env.example to .env and add your HenrikDev key.');
});
