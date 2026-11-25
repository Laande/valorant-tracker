import fs from 'node:fs';
import path from 'node:path';

const API_BASE = 'https://api.henrikdev.xyz/valorant';
const REGIONS = new Set(['na', 'eu', 'ap', 'kr', 'br', 'latam']);
const PLATFORMS = new Set(['pc', 'console']);
const MAX_MATCHES = 100;
export const PAGE_SIZE = 10;

export class ApiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function loadEnv(file = '.env') {
  const target = path.resolve(process.cwd(), file);
  if (!fs.existsSync(target)) return;

  for (const line of fs.readFileSync(target, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export function getApiKey() {
  if (!process.env.HENRIKDEV_API_KEY) loadEnv();
  return (process.env.HENRIKDEV_API_KEY || '').trim();
}

export function validateQuery(raw) {
  const name = String(raw.name || '').trim();
  const tag = String(raw.tag || '').replace(/^#/, '').trim();
  const region = String(raw.region || 'eu').toLowerCase();
  const platform = String(raw.platform || 'pc').toLowerCase();
  const count = Number(raw.count ?? 10);

  if (!name || !/^[\p{L}\p{N} _.\-']{1,40}$/u.test(name)) {
    return { error: 'Invalid Riot name (letters, numbers, spaces, dots and hyphens only).' };
  }
  if (!tag || !/^[\p{L}\p{N}]{2,8}$/u.test(tag)) {
    return { error: 'Invalid Riot tag (2 to 8 letters or numbers, without #).' };
  }
  if (!REGIONS.has(region)) {
    return { error: 'Invalid region.' };
  }
  if (!PLATFORMS.has(platform)) {
    return { error: 'Invalid platform.' };
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_MATCHES) {
    return { error: `Invalid match count (between 1 and ${MAX_MATCHES}).` };
  }

  return { value: { name, tag, region, platform, count } };
}

function apiErrorMessage(status, body) {
  const message = body?.errors?.[0]?.message;
  if (status === 429) return 'HenrikDev rate limit reached. Try again in a minute.';
  if (status === 404) return 'No account found for this Riot ID and region.';
  if (status === 401 || status === 403) return 'HenrikDev rejected the API key. Check your key in .env.';
  if (status === 400) return `Request rejected by HenrikDev: ${message || 'invalid parameters'}.`;
  if (status >= 500) return 'HenrikDev is temporarily unavailable. Try again later.';
  return message || 'Error while fetching data.';
}

async function request(resource) {
  const key = getApiKey();
  if (!key || key.includes('paste_your_key')) {
    throw new ApiError('No API key configured. Copy .env.example to .env and add your HenrikDev key.', 503);
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${resource}`, {
      headers: { Authorization: key, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ApiError('HenrikDev took too long to respond.', 504);
    }
    throw new ApiError('Could not reach HenrikDev.', 502);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new ApiError('Could not read the response from HenrikDev.', 502);
  }

  if (!response.ok || (Number.isInteger(body?.status) && body.status >= 400)) {
    throw new ApiError(apiErrorMessage(response.status, body), response.status);
  }

  return body.data;
}

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

export function normalizeMatch(match, puuid) {
  const metadata = match.metadata || {};
  const teams = new Map((match.teams || []).map((team) => [team.team_id, team]));

  const roundsByPlayer = new Map();
  for (const round of match.rounds || []) {
    for (const stat of round.stats || []) {
      const id = stat.player?.puuid;
      if (id) roundsByPlayer.set(id, (roundsByPlayer.get(id) || 0) + 1);
    }
  }
  const firstTeam = match.teams?.[0];
  const matchRounds = firstTeam ? number(firstTeam.rounds?.won) + number(firstTeam.rounds?.lost) : 0;

  const players = (match.players || []).map((player) => {
    const stats = player.stats || {};
    const team = teams.get(player.team_id);
    return {
      puuid: player.puuid,
      name: player.name || 'Unknown',
      tag: player.tag || '',
      agent: player.agent?.name || '?',
      tier: player.tier?.name || '',
      level: number(player.account_level),
      teamId: player.team_id,
      partyId: player.party_id || null,
      performanceScore: player.performance?.score ?? null,
      isMe: player.puuid === puuid,
      won: Boolean(team?.won),
      kills: number(stats.kills),
      deaths: number(stats.deaths),
      assists: number(stats.assists),
      score: number(stats.score),
      roundsPlayed: roundsByPlayer.get(player.puuid) || matchRounds,
      damage: number(stats.damage?.dealt),
      headshots: number(stats.headshots),
      bodyshots: number(stats.bodyshots),
      legshots: number(stats.legshots),
    };
  });

  return {
    id: metadata.match_id,
    startedAt: metadata.started_at,
    map: metadata.map?.name || 'Unknown',
    mode: metadata.queue?.name || metadata.queue?.id || 'Normal',
    durationMs: number(metadata.game_length_in_ms),
    players,
    teams: (match.teams || []).map((team) => ({
      teamId: team.team_id,
      roundsWon: number(team.rounds?.won),
    })),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchMatches({ name, tag, region, platform, count }) {
  const account = await request(`/v2/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
  const puuid = account.puuid;
  if (!puuid) throw new ApiError('Could not resolve this account (missing PUUID).', 502);

  const matches = [];
  let start = 0;

  while (matches.length < count) {
    const size = Math.min(PAGE_SIZE, count - matches.length);
    const page = await request(
      `/v4/by-puuid/matches/${region}/${platform}/${encodeURIComponent(puuid)}?size=${size}&start=${start}`,
    );

    if (!Array.isArray(page) || page.length === 0) break;
    matches.push(...page.map((match) => normalizeMatch(match, puuid)));
    start += page.length;
    if (page.length < size) break;
    if (matches.length < count) await sleep(150);
  }

  return {
    account: {
      name: account.name || name,
      tag: account.tag || tag,
      puuid,
      region,
      platform,
      level: number(account.account_level),
    },
    matches: matches.slice(0, count),
  };
}
