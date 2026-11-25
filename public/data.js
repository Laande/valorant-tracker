const safeDivide = (a, b) => (b ? a / b : 0);

export function getAcs(score, roundsPlayed) {
  return Math.round(safeDivide(score, roundsPlayed));
}

export function getHeadshotRate(headshots, bodyshots, legshots) {
  const shots = (headshots || 0) + (bodyshots || 0) + (legshots || 0);
  return shots ? Math.round(((headshots || 0) / shots) * 100) : 0;
}

const localTimeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

export function getDayKey(isoDate, timeZone = localTimeZone) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return 'unknown';

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function formatDayLabel(dayKey, locale = 'en-GB') {
  const date = new Date(`${dayKey}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return dayKey;
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function emptyDay(key, locale) {
  return {
    key,
    label: formatDayLabel(key, locale),
    matches: 0,
    wins: 0,
    losses: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    damage: 0,
    headshots: 0,
    bodyshots: 0,
    legshots: 0,
    durationMs: 0,
  };
}

export function aggregate(matches, { puuid, timeZone = localTimeZone, locale = 'en-GB' } = {}) {
  const days = new Map();
  const players = new Map();

  for (const match of matches) {
    const key = getDayKey(match.startedAt, timeZone);
    if (!days.has(key)) days.set(key, emptyDay(key, locale));
    const day = days.get(key);
    const me = match.players.find((player) => player.isMe || player.puuid === puuid) || null;

    day.matches += 1;
    day.damage += me?.damage || 0;
    day.kills += me?.kills || 0;
    day.deaths += me?.deaths || 0;
    day.assists += me?.assists || 0;
    day.headshots += me?.headshots || 0;
    day.bodyshots += me?.bodyshots || 0;
    day.legshots += me?.legshots || 0;
    day.durationMs += match.durationMs || 0;
    if (me?.won) day.wins += 1;
    else day.losses += 1;

    for (const player of match.players) {
      if (!players.has(player.puuid)) {
        players.set(player.puuid, {
          puuid: player.puuid,
          name: player.name,
          tag: player.tag,
          agent: player.agent,
          level: player.level || "—",
          games: 0,
          wins: 0,
          kills: 0,
          deaths: 0,
          assists: 0,
          score: 0,
          roundsPlayed: 0,
          performanceTotal: 0,
          performanceGames: 0,
          damage: 0,
          headshots: 0,
        });
      }
      const entry = players.get(player.puuid);
      if (!entry.level && player.level) entry.level = player.level;
      entry.games += 1;
      if (player.won) entry.wins += 1;
      entry.kills += player.kills || 0;
      entry.deaths += player.deaths || 0;
      entry.assists += player.assists || 0;
      entry.score += player.score || 0;
      entry.roundsPlayed += player.roundsPlayed || 0;
      if (Number.isFinite(player.performanceScore)) {
        entry.performanceTotal += player.performanceScore;
        entry.performanceGames += 1;
      }
      entry.damage += player.damage || 0;
      entry.headshots += player.headshots || 0;
    }
  }

  const dayList = [...days.values()].sort((a, b) => b.key.localeCompare(a.key));

  const playerList = [...players.values()]
    .map((player) => {
      const acs = getAcs(player.score, player.roundsPlayed);
      return {
        ...player,
        avgDamage: Math.round(safeDivide(player.damage, player.games)),
        acs,
        score: player.performanceGames ? Math.round(safeDivide(player.performanceTotal, player.performanceGames)) : acs,
        kd: Number(safeDivide(player.kills, player.deaths).toFixed(2)),
      };
    })
    .sort((a, b) => b.damage - a.damage);

  const totals = {
    matches: matches.length,
    wins: dayList.reduce((total, day) => total + day.wins, 0),
    kills: dayList.reduce((total, day) => total + day.kills, 0),
    deaths: dayList.reduce((total, day) => total + day.deaths, 0),
    assists: dayList.reduce((total, day) => total + day.assists, 0),
    damage: dayList.reduce((total, day) => total + day.damage, 0),
    headshots: dayList.reduce((total, day) => total + day.headshots, 0),
    bodyshots: dayList.reduce((total, day) => total + day.bodyshots, 0),
    legshots: dayList.reduce((total, day) => total + day.legshots, 0),
    durationMs: dayList.reduce((total, day) => total + day.durationMs, 0),
    activeDays: dayList.length,
  };
  totals.winrate = Math.round(safeDivide(totals.wins, totals.matches) * 100);
  totals.avgDamage = Math.round(safeDivide(totals.damage, totals.matches));
  totals.kd = Number(safeDivide(totals.kills, totals.deaths).toFixed(2));
  totals.headshotRate = getHeadshotRate(totals.headshots, totals.bodyshots, totals.legshots);

  return { days: dayList, players: playerList, totals };
}
