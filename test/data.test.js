import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, getAcs, getDayKey, getHeadshotRate } from '../public/data.js';
import { normalizeMatch, validateQuery } from '../lib/henrik.js';

function player(puuid, overrides = {}) {
  return {
    puuid,
    name: `Player ${puuid}`,
    tag: 'EUW',
    agent: 'Jett',
    teamId: overrides.won === false ? 'b' : 'a',
    isMe: puuid === 'me',
    won: overrides.won !== false,
    kills: 10,
    deaths: 5,
    assists: 3,
    damage: 1500,
    headshots: 6,
    bodyshots: 20,
    legshots: 4,
    ...overrides,
  };
}

function match(id, startedAt, players) {
  return {
    id,
    startedAt,
    map: 'Ascent',
    mode: 'Competitive',
    durationMs: 2400000,
    players,
    teams: [
      { teamId: 'a', won: true, roundsWon: 13, roundsLost: 7 },
      { teamId: 'b', won: false, roundsWon: 7, roundsLost: 13 },
    ],
  };
}

test('getDayKey uses the requested time zone', () => {
  const iso = '2026-11-21T23:30:00Z';
  assert.equal(getDayKey(iso, 'UTC'), '2026-11-21');
  assert.equal(getDayKey(iso, 'Europe/Paris'), '2026-11-22');
  assert.equal(getDayKey('not-a-date', 'UTC'), 'unknown');
});

test('getAcs divides score by rounds played', () => {
  assert.equal(getAcs(5938, 16), 371);
  assert.equal(getAcs(500, 0), 0);
});

test('getHeadshotRate returns a percentage of total shots', () => {
  assert.equal(getHeadshotRate(6, 20, 4), 20);
  assert.equal(getHeadshotRate(0, 0, 0), 0);
});

test('aggregate sums damage per day and per player', () => {
  const matches = [
    match('m1', '2026-11-20T20:00:00Z', [player('me', { damage: 2000, kills: 12 }), player('p2', { damage: 1000, won: false }), player('p3', { damage: 500, won: false })]),
    match('m2', '2026-11-21T20:00:00Z', [player('me', { damage: 3000, kills: 8 }), player('p2', { damage: 2500, won: false }), player('p3', { damage: 700, won: false })]),
  ];

  const result = aggregate(matches, { puuid: 'me', timeZone: 'UTC' });

  assert.equal(result.days.length, 2);
  assert.equal(result.days[0].key, '2026-11-21');
  assert.equal(result.days[0].damage, 3000);
  assert.equal(result.days[1].key, '2026-11-20');
  assert.equal(result.days[1].damage, 2000);
  assert.equal(result.totals.damage, 5000);
  assert.equal(result.totals.wins, 2);
  assert.equal(result.totals.winrate, 100);
  assert.equal(result.totals.kd, 2);

  const me = result.players.find((entry) => entry.puuid === 'me');
  const other = result.players.find((entry) => entry.puuid === 'p2');
  assert.equal(me.damage, 5000);
  assert.equal(me.games, 2);
  assert.equal(other.damage, 3500);
  assert.equal(result.players[0].puuid, 'me');
});

test('aggregate handles an empty list', () => {
  const result = aggregate([], { puuid: 'me' });
  assert.deepEqual(result.days, []);
  assert.deepEqual(result.players, []);
  assert.equal(result.totals.damage, 0);
  assert.equal(result.totals.winrate, 0);
});

test('normalizeMatch extracts damage dealt', () => {
  const raw = {
    metadata: {
      match_id: 'abc',
      started_at: '2026-11-21T20:00:00Z',
      map: { name: 'Bind' },
      queue: { name: 'Competitive' },
      game_length_in_ms: 120000,
      is_completed: true,
    },
    teams: [{ team_id: 'a', won: true, rounds: { won: 13, lost: 5 } }],
    players: [
      {
        puuid: 'me',
        name: 'Me',
        tag: 'EUW',
        team_id: 'a',
        party_id: 'party-1',
        account_level: 123,
        performance: { score: 309 },
        agent: { name: 'Reyna' },
        tier: { name: 'Gold 2' },
        stats: { kills: 20, deaths: 10, assists: 4, score: 500, headshots: 8, damage: { dealt: 3200, received: 2100 } },
      },
    ],
  };

  const normalized = normalizeMatch(raw, 'me');
  assert.equal(normalized.map, 'Bind');
  assert.equal(normalized.players[0].damage, 3200);
  assert.equal(normalized.players[0].tier, 'Gold 2');
  assert.equal(normalized.players[0].isMe, true);
  assert.equal(normalized.players[0].partyId, 'party-1');
  assert.equal(normalized.players[0].level, 123);
  assert.equal(normalized.players[0].performanceScore, 309);
  assert.equal(normalized.players[0].roundsPlayed, 18);
  assert.equal(normalized.teams[0].roundsWon, 13);
});

test('aggregate uses the in-game performance score when available', () => {
  const matches = [
    match('m1', '2026-11-20T20:00:00Z', [player('me', { performanceScore: 309 }), player('p2', { performanceScore: 240, won: false })]),
    match('m2', '2026-11-21T20:00:00Z', [player('me', { performanceScore: 251 }), player('p2', { performanceScore: 180, won: false })]),
  ];

  const result = aggregate(matches, { puuid: 'me', timeZone: 'UTC' });
  assert.equal(result.players.find((entry) => entry.puuid === 'me').score, 280);
  assert.equal(result.players.find((entry) => entry.puuid === 'p2').score, 210);
});

test('normalizeMatch keeps the party id', () => {
  const raw = {
    metadata: { match_id: 'abc', started_at: '2026-11-21T20:00:00Z', map: { name: 'Bind' } },
    teams: [{ team_id: 'a', won: true, rounds: { won: 13, lost: 5 } }],
    players: [
      { puuid: 'me', name: 'Me', tag: 'EUW', team_id: 'a', party_id: 'party-1', stats: {} },
      { puuid: 'mate', name: 'Mate', tag: 'EUW', team_id: 'a', party_id: 'party-1', stats: {} },
      { puuid: 'solo', name: 'Solo', tag: 'EUW', team_id: 'a', party_id: 'party-2', stats: {} },
    ],
  };

  const normalized = normalizeMatch(raw, 'me');
  assert.equal(normalized.players[0].partyId, 'party-1');
  assert.equal(normalized.players[1].partyId, 'party-1');
  assert.equal(normalized.players[2].partyId, 'party-2');
});

test('normalizeMatch counts the rounds each player actually played', () => {
  const raw = {
    metadata: { match_id: 'abc', started_at: '2026-11-21T20:00:00Z', map: { name: 'Split' }, queue: { id: 'competitive' } },
    teams: [{ team_id: 'a', won: true, rounds: { won: 13, lost: 3 } }],
    players: [
      { puuid: 'me', name: 'Me', tag: 'EUW', team_id: 'a', stats: { score: 3000 } },
      { puuid: 'late', name: 'Late', tag: 'EUW', team_id: 'a', stats: { score: 400 } },
    ],
    rounds: [
      { stats: [{ player: { puuid: 'me' } }, { player: { puuid: 'late' } }] },
      { stats: [{ player: { puuid: 'me' } }, { player: { puuid: 'late' } }] },
      { stats: [{ player: { puuid: 'me' } }] },
    ],
  };

  const normalized = normalizeMatch(raw, 'me');
  assert.equal(normalized.players[0].roundsPlayed, 3);
  assert.equal(normalized.players[1].roundsPlayed, 2);
  assert.equal(getAcs(normalized.players[0].score, normalized.players[0].roundsPlayed), 1000);
});

test('validateQuery checks inputs', () => {
  assert.equal(validateQuery({ name: 'Toto', tag: '#EUW', region: 'EU', platform: 'PC', count: 30 }).error, undefined);
  assert.ok(validateQuery({ name: '', tag: 'EUW' }).error);
  assert.ok(validateQuery({ name: 'Toto', tag: 'EUW', region: 'zz' }).error);
  assert.ok(validateQuery({ name: 'Toto', tag: 'EUW', count: 1000 }).error);
});
