import { aggregate, getAcs, getDayKey, getHeadshotRate } from './data.js';

const $ = (id) => document.getElementById(id);
const numberFormat = new Intl.NumberFormat('en-GB');
const state = { raw: null, data: null, sort: { key: 'score', dir: 'desc' } };

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const fmt = (value) => numberFormat.format(Math.round(value || 0));
const initial = (name) => escapeHtml(String(name || '?').trim().charAt(0).toUpperCase());

const hsRate = (player) => getHeadshotRate(player.headshots, player.bodyshots, player.legshots);

const acs = (player) => getAcs(player.score, player.roundsPlayed);
const scoreValue = (player) => (Number.isFinite(player.performanceScore) ? Math.round(player.performanceScore) : acs(player));

const sortValue = (player, key = state.sort.key) => {
  if (key === 'hs') return hsRate(player);
  if (key === 'score') return scoreValue(player);
  if (key === 'acs') return acs(player);
  return player[key] || 0;
};

const sortIcon = (key) => (state.sort.key === key ? (state.sort.dir === 'desc' ? '▼' : '▲') : '↕');

const slugify = (name) =>
  String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');

function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function restoreForm() {
  try {
    const saved = JSON.parse(localStorage.getItem('valorant-tracker-form') || '{}');
    for (const id of ['name', 'tag', 'region', 'platform', 'count']) {
      if (saved[id] !== undefined) $(id).value = saved[id];
    }
  } catch {
    localStorage.removeItem('valorant-tracker-form');
  }
}

function saveForm() {
  const values = {};
  for (const id of ['name', 'tag', 'region', 'platform', 'count']) values[id] = $(id).value;
  localStorage.setItem('valorant-tracker-form', JSON.stringify(values));
}

function showError(message) {
  $('errorBox').textContent = message;
  $('errorBox').hidden = false;
}

function setBusy(busy) {
  $('submit').disabled = busy;
  $('lastMatch').disabled = busy;
  $('submit').querySelector('span').textContent = busy ? 'Loading…' : 'Load stats';
  $('loading').hidden = !busy;
  if (busy) $('errorBox').hidden = true;
}

async function load({ force = false, count } = {}) {
  const name = $('name').value.trim();
  const tag = $('tag').value.trim().replace(/^#/, '');
  const hint = $('formHint');

  if (!name || !tag) {
    hint.textContent = 'Enter your Riot ID and tag (for example #EUW).';
    hint.classList.add('error');
    return;
  }
  hint.textContent = '';
  hint.classList.remove('error');
  saveForm();
  setBusy(true);

  const params = new URLSearchParams({
    name,
    tag,
    region: $('region').value,
    platform: $('platform').value,
    count: String(count ?? $('count').value),
  });
  if (force) params.set('refresh', '1');

  try {
    const response = await fetch(`/api/matches?${params}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not load stats.');

    state.raw = payload;
    state.raw.matches.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    $('empty').hidden = true;
    $('dashboard').hidden = false;
    render();
  } catch (error) {
    showError(error.message);
    if (!state.raw) {
      $('empty').hidden = false;
      $('dashboard').hidden = true;
    }
  } finally {
    setBusy(false);
  }
}

function renderKpis(totals) {
  const cards = [
    { label: 'Matches analyzed', value: fmt(totals.matches), sub: `${totals.activeDays} day${totals.activeDays > 1 ? 's' : ''}` },
    { label: 'Wins', value: fmt(totals.wins), sub: `${totals.winrate}% win rate`, accent: true },
    { label: 'Damage dealt', value: fmt(totals.damage), sub: `${fmt(totals.avgDamage)} / match`, accent: true },
    { label: 'K / D / A', value: `${fmt(totals.kills)}/${fmt(totals.deaths)}/${fmt(totals.assists)}`, sub: `K/D ${totals.kd}` },
    { label: 'Headshots', value: `${totals.headshotRate}%`, sub: `${fmt(totals.headshots)} headshots` },
    { label: 'Playtime', value: `${Math.round(totals.durationMs / 3600000)} h`, sub: 'over this period' },
  ];

  $('kpis').innerHTML = cards
    .map(
      (card) => `<article class="kpi">
        <div class="kpi-label">${escapeHtml(card.label)}</div>
        <div class="kpi-value${card.accent ? ' accent' : ''}">${escapeHtml(card.value)}</div>
        <div class="kpi-sub">${escapeHtml(card.sub)}</div>
      </article>`,
    )
    .join('');
}

function myTeamId(match) {
  return match.players.find((player) => player.isMe)?.teamId;
}

function teamClass(match, player) {
  return player.teamId === myTeamId(match) ? 'team-blue' : 'team-red';
}

function partyInfo(match) {
  const sizes = new Map();
  for (const player of match.players || []) {
    if (!player.partyId) continue;
    sizes.set(player.partyId, (sizes.get(player.partyId) || 0) + 1);
  }
  const parties = new Map();
  for (const [id, size] of sizes) {
    if (size > 1) parties.set(id, { size, color: parties.size % 6 });
  }
  return parties;
}

function partyBadge(party) {
  if (!party) return '';
  const label = party.size === 2 ? 'DUO' : party.size === 3 ? 'TRIO' : `x${party.size}`;
  return `<span class="party-badge party-color-${party.color}">${label}</span>`;
}

function scoreHtml(match) {
  const mine = myTeamId(match);
  const myTeam = (match.teams || []).find((team) => team.teamId === mine);
  const enemy = (match.teams || []).find((team) => team.teamId !== mine);
  if (!myTeam || !enemy) return '—';
  return `<span class="team-blue-text">${myTeam.roundsWon}</span><span class="score-sep">-</span><span class="team-red-text">${enemy.roundsWon}</span>`;
}

function sortedPlayers(match) {
  const sign = state.sort.dir === 'asc' ? 1 : -1;
  return [...match.players].sort((a, b) => sign * (sortValue(a) - sortValue(b)) || b.damage - a.damage);
}

function sortHeader(key, label, title = '') {
  const active = state.sort.key === key;
  const tooltip = title ? ` title="${escapeHtml(title)}"` : '';
  return `<th class="num${active ? ' sorted' : ''}" data-sort="${key}"${tooltip}>${label}<span class="sort-icon">${sortIcon(key)}</span></th>`;
}

function rowsBody(match) {
  const parties = partyInfo(match);
  return sortedPlayers(match)
    .map((player) => {
      const rank = player.tier || '';
      const party = parties.get(player.partyId);
      return `<tr class="${teamClass(match, player)}${player.isMe ? ' me' : ''}" data-puuid="${escapeHtml(player.puuid)}">
        <td>
          <div class="player-cell">
            <span class="player-avatar">${initial(player.name)}</span>
            <img class="agent-icon" src="/agents/${escapeHtml(slugify(player.agent))}.png" alt="" loading="lazy"
              onerror="this.style.display='none';this.previousElementSibling.style.display='grid'" />
            <div>
              <div class="player-name">${escapeHtml(player.name)}#${escapeHtml(player.tag)}${player.isMe ? '<span class="tag-you">YOU</span>' : ''}${partyBadge(party)}</div>
              <div class="player-sub">${escapeHtml(player.agent)}</div>
            </div>
          </div>
        </td>
        <td class="rank-cell">
          <div class="rank-cell-inner">
            ${rank ? `<img class="rank-icon" src="/ranks/${escapeHtml(slugify(rank))}.png" alt="" loading="lazy" onerror="this.style.display='none'" />` : ''}
            <span>${escapeHtml(rank || '—')}</span>
          </div>
        </td>
        <td class="num score-cell">${fmt(scoreValue(player))}</td>
        <td class="num">${fmt(player.kills)}</td>
        <td class="num">${fmt(player.deaths)}</td>
        <td class="num">${fmt(player.assists)}</td>
        <td class="num">${hsRate(player)}%</td>
        <td class="num dmg-cell">${fmt(player.damage)}</td>
      </tr>`;
    })
    .join('');
}

function updateSortIndicators(table) {
  table.querySelectorAll('th[data-sort]').forEach((th) => {
    const active = th.dataset.sort === state.sort.key;
    th.classList.toggle('sorted', active);
    th.querySelector('.sort-icon').textContent = sortIcon(th.dataset.sort);
  });
}

function playerTable(match) {
  return `<table class="match-players" data-match-id="${escapeHtml(match.id)}">
    <thead><tr>
      <th>Player</th>
      <th title="Rank at the time of the match">Rank</th>
      ${sortHeader('score', 'Score', 'Performance score shown in game')}
      ${sortHeader('kills', 'K')}
      ${sortHeader('deaths', 'D')}
      ${sortHeader('assists', 'A')}
      ${sortHeader('hs', 'HS')}
      ${sortHeader('damage', 'Damage')}
    </tr></thead>
    <tbody>${rowsBody(match)}</tbody>
  </table>`;
}

function renderDays(data, expandMatches = false) {
  const grouped = new Map();
  for (const match of state.raw.matches) {
    const key = getDayKey(match.startedAt);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(match);
  }

  $('days').innerHTML = data.days
    .map((day, index) => {
      const matches = grouped.get(day.key) || [];
      const matchBlocks = matches
        .map((match) => {
          const me = match.players.find((player) => player.isMe) || null;
          const result = me?.won ? 'win' : 'lose';
          return `<details class="match" ${expandMatches ? 'open' : ''}>
            <summary>
              <div class="match-head">
                <div class="match-map">
                  <span class="match-caret">▶</span>
                  <img class="map-icon" src="/maps/${escapeHtml(slugify(match.map))}.png" alt="" loading="lazy" onerror="this.remove()" />
                  <span>${escapeHtml(match.map)}</span>
                </div>
                <span class="match-score">${scoreHtml(match)}</span>
                <div class="match-meta">
                  <span class="match-mode">${escapeHtml(match.mode)}</span>
                  <span class="match-mode">Duration ${formatDuration(match.durationMs)}</span>
                  <span class="match-result ${result}">${me?.won ? 'WIN' : 'LOSS'}</span>
                </div>
              </div>
            </summary>
            <div class="table-wrap">${playerTable(match)}</div>
          </details>`;
        })
        .join('');

      return `<details class="day-card" ${index === 0 ? 'open' : ''}>
        <summary>
          <span class="day-caret">▶</span>
          <span class="day-date">${escapeHtml(day.label)}</span>
          <span class="day-stats">
            <span><b>${day.matches}</b> match${day.matches > 1 ? 'es' : ''}</span>
            <span><b>${day.wins}W / ${day.losses}L</b></span>
            <span><b>${fmt(day.kills)}/${fmt(day.deaths)}/${fmt(day.assists)}</b> K/D/A</span>
            <span class="hs"><b>${hsRate(day)}%</b> HS</span>
            <span class="dmg"><b>${fmt(day.damage)}</b> damage</span>
          </span>
        </summary>
        <div class="day-body">${matchBlocks}</div>
      </details>`;
    })
    .join('');
}

function render() {
  if (!state.raw) return;
  const account = state.raw.account;
  $('accountAvatar').textContent = initial(account.name);
  $('accountName').textContent = `${account.name}#${account.tag}`;
  $('accountMeta').textContent = `${account.region.toUpperCase()} · ${account.platform.toUpperCase()} · Level ${account.level || '—'} · ${state.raw.matches.length} matches${state.raw.cached ? ' · cached' : ''}`;

  state.data = aggregate(state.raw.matches, { puuid: account.puuid });
  renderKpis(state.data.totals);
  renderDays(state.data, state.raw.matches.length === 1);
}

function exportCsv() {
  if (!state.data?.players.length) return;
  const rows = [
    ['Riot ID', 'Agent', 'Matches', 'Wins', 'Losses', 'Kills', 'Deaths', 'Assists', 'Score', 'KD', 'Total damage', 'Damage per match', 'Headshots'],
    ...state.data.players.map((player) => [
      `${player.name}#${player.tag}`,
      player.agent,
      player.games,
      player.wins,
      player.games - player.wins,
      player.kills,
      player.deaths,
      player.assists,
      player.score,
      player.kd,
      player.damage,
      player.avgDamage,
      player.headshots,
    ]),
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `valorant-players-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function checkConfig() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    const badge = $('configBadge');
    if (config.configured) {
      badge.textContent = 'API connected';
      badge.className = 'badge ok';
    } else {
      badge.textContent = 'API key missing';
      badge.className = 'badge error';
      $('formHint').textContent = 'Copy .env.example to .env and add your HenrikDev key.';
    }
  } catch {
    showError('Could not reach the local server.');
  }
}

$('searchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  load();
});

$('lastMatch').addEventListener('click', () => load({ count: 1 }));
$('refresh').addEventListener('click', () => load({ force: true }));
$('export').addEventListener('click', exportCsv);

$('days').addEventListener('click', (event) => {
  const th = event.target.closest('th[data-sort]');
  if (!th) return;

  const key = th.dataset.sort;
  if (state.sort.key === key) state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
  else state.sort = { key, dir: 'desc' };

  const table = th.closest('table');
  const match = state.raw?.matches.find((item) => item.id === table.dataset.matchId);
  if (!match) return;

  const sign = state.sort.dir === 'asc' ? 1 : -1;
  const players = new Map(match.players.map((player) => [player.puuid, player]));
  const tbody = table.querySelector('tbody');

  [...tbody.querySelectorAll('tr')]
    .sort((a, b) => {
      const playerA = players.get(a.dataset.puuid) || {};
      const playerB = players.get(b.dataset.puuid) || {};
      return sign * (sortValue(playerA) - sortValue(playerB)) || (playerB.damage || 0) - (playerA.damage || 0);
    })
    .forEach((row) => tbody.appendChild(row));

  updateSortIndicators(table);
});

for (const id of ['name', 'tag', 'region', 'platform', 'count']) {
  $(id).addEventListener('input', saveForm);
  $(id).addEventListener('change', saveForm);
}

restoreForm();
checkConfig();
