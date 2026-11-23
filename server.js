import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, PAGE_SIZE, fetchMatches, getApiKey, loadEnv, validateQuery } from './lib/henrik.js';

loadEnv();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const CACHE_TTL = 5 * 60 * 1000;
const RATE_CAPACITY = Number(process.env.RATE_LIMIT_PER_MINUTE) || 30;
const RATE_REFILL = RATE_CAPACITY / 60000;
const MAX_IN_FLIGHT = 2;
const cache = new Map();
const rateBuckets = new Map();
const inFlight = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function clientIp(request) {
  return request.socket.remoteAddress || 'unknown';
}

function consumeTokens(ip, cost) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE_CAPACITY, updated: now };
    rateBuckets.set(ip, bucket);
  }
  bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + (now - bucket.updated) * RATE_REFILL);
  bucket.updated = now;

  if (rateBuckets.size > 500) {
    for (const [key, entry] of rateBuckets) {
      if (now - entry.updated > 10 * 60 * 1000) rateBuckets.delete(key);
    }
  }

  if (bucket.tokens < cost) {
    return { retry: Math.ceil((cost - bucket.tokens) / RATE_REFILL / 1000), remaining: 0 };
  }
  bucket.tokens -= cost;
  return { retry: 0, remaining: Math.floor(bucket.tokens) };
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
    const force = url.searchParams.get('refresh') === '1';
    if (!force) {
      const cached = getCached(key);
      if (cached) {
        sendJson(response, 200, { ...cached, cached: true });
        return;
      }
    }

    const ip = clientIp(request);
    if ((inFlight.get(ip) || 0) >= MAX_IN_FLIGHT) {
      sendJson(response, 429, { error: 'Too many simultaneous requests.' }, { 'Retry-After': '1' });
      return;
    }
    const cost = Math.max(1, Math.ceil(query.count / PAGE_SIZE));
    const limit = consumeTokens(ip, cost);
    if (limit.retry) {
      sendJson(
        response,
        429,
        { error: `Too many requests. Try again in ${limit.retry}s.` },
        { 'Retry-After': String(limit.retry), 'X-RateLimit-Remaining': '0' },
      );
      return;
    }

    inFlight.set(ip, (inFlight.get(ip) || 0) + 1);
    if (force) cache.delete(key);
    try {
      const payload = await fetchMatches(query);
      setCached(key, payload);
      sendJson(response, 200, { ...payload, cached: false }, { 'X-RateLimit-Remaining': String(limit.remaining) });
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(response, error.status, { error: error.message }, { 'X-RateLimit-Remaining': String(limit.remaining) });
        return;
      }
      console.error('Unexpected error:', error);
      sendJson(response, 500, { error: 'Internal server error.' });
    } finally {
      const active = (inFlight.get(ip) || 1) - 1;
      if (active > 0) inFlight.set(ip, active);
      else inFlight.delete(ip);
    }
    return;
  }

  await serveStatic(response, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Valorant Tracker listening on ${HOST}:${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
  if (!getApiKey()) console.log('API key missing: copy .env.example to .env and add your HenrikDev key.');
});
