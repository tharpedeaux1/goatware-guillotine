/* Guillotine League front end (no build step) */
const $app = document.getElementById('app');
const state = {
  token: localStorage.getItem('gl_token') || null,
  adminKey: localStorage.getItem('gl_admin') || '',
  me: null,
  timer: null,
  dirty: false,
  filter: { pos: '', q: '', all: false },
  openRow: null,
};

const STAT_LABELS = {
  pass_yd: 'Passing yards', pass_td: 'Passing TD', pass_int: 'Interceptions thrown', pass_2pt: 'Passing 2-pt',
  pass_att: 'Pass attempts', pass_cmp: 'Completions', rush_att: 'Rush attempts', rush_yd: 'Rushing yards',
  rush_td: 'Rushing TD', rush_2pt: 'Rushing 2-pt', rec_tgt: 'Targets', rec: 'Receptions', rec_yd: 'Receiving yards',
  rec_td: 'Receiving TD', rec_2pt: 'Receiving 2-pt', fum_lost: 'Fumbles lost', st_td: 'Return TD', gp: 'Games played',
  fgm: 'FG made', fga: 'FG attempts', xpm: 'XP made', xpa: 'XP attempts', fgmiss: 'FG missed', xpmiss: 'XP missed',
  fgm_0_19: 'FG 0-19', fgm_20_29: 'FG 20-29', fgm_30_39: 'FG 30-39', fgm_40_49: 'FG 40-49', fgm_50p: 'FG 50+',
  sack: 'Sacks', int: 'Interceptions', fum_rec: 'Fumble recoveries', def_td: 'Defensive TD', def_st_td: 'Def/ST TD',
  safe: 'Safeties', blk_kick: 'Blocked kicks', pts_allow: 'Points allowed',
};

// ------------------------------------------------------------ helpers
async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers['x-team-token'] = state.token;
  if (opts.admin) headers['x-admin-key'] = state.adminKey;
  const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({ error: `The server sent an unexpected response (${res.status}).` }));
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status}).`); e.status = res.status; throw e; }
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pts = (n) => (Number(n) || 0).toFixed(2);
const kick = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const ago = (ms) => {
  if (!ms) return 'not yet';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = ''; }, 3200);
}
async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); return true; } catch (e) { toast(e.message, 'error'); return false; }
}
function gameText(g) {
  if (!g) return '<span class="muted">Bye</span>';
  const vs = `${g.home ? 'vs' : '@'} ${esc(g.opp)}`;
  if (g.state === 'pre') return `${vs} <span class="muted">${kick(g.kickoff)}</span>`;
  if (g.state === 'in') return `${vs} <span class="gstate-in">${g.team_score}-${g.opp_score}, ${esc(g.detail)}</span>`;
  const res = g.team_score > g.opp_score ? 'W' : g.team_score < g.opp_score ? 'L' : 'T';
  return `${vs} <span class="muted">${res} ${g.team_score}-${g.opp_score}</span>`;
}
function eligibleSlots(pos, slots, flex) {
  return Object.keys(slots).filter((s) => s === 'BN' || (flex[s] ? flex[s].includes(pos) : s === pos));
}

async function loadMe() {
  state.me = null;
  if (state.token) {
    try { state.me = (await api('/api/me')).team; } catch (e) { if (e.status === 401) { localStorage.removeItem('gl_token'); state.token = null; } }
  }
  const link = document.getElementById('my-team-link');
  link.hidden = !state.me;
  if (state.me) link.href = `#team/${state.me.id}`;
}

// ------------------------------------------------------------ router
async function router() {
  clearInterval(state.timer);
  const [view, arg] = (location.hash.slice(1) || 'live').split('/');
  if (view === 'join' && arg) {
    state.token = arg;
    localStorage.setItem('gl_token', arg);
    await loadMe();
    location.replace(state.me ? `#team/${state.me.id}` : '#live');
    if (!state.me) toast('That team link is not valid. Ask the commissioner for a new one.', 'error');
    return;
  }
  document.querySelectorAll('.nav a').forEach((a) => {
    const current = a.dataset.view === view || (a.dataset.view === 'mine' && view === 'team' && state.me && Number(arg) === state.me.id);
    if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  state.dirty = false;
  try {
    if (view === 'live') { await renderLive(); state.timer = setInterval(() => renderLive().catch(() => {}), 30000); }
    else if (view === 'team') { await renderTeam(Number(arg)); state.timer = setInterval(() => { if (!state.dirty && !state.openRow) renderTeam(Number(arg)).catch(() => {}); }, 30000); }
    else if (view === 'players') await renderPlayers();
    else if (view === 'graveyard') await renderGraveyard();
    else if (view === 'activity') await renderActivity();
    else if (view === 'admin') await renderAdmin();
    else location.replace('#live');
  } catch (e) {
    $app.innerHTML = `<section class="empty"><h1>This page didn't load</h1><p>${esc(e.message)}</p><button class="btn" id="retry">Try again</button></section>`;
    document.getElementById('retry').onclick = router;
  }
}

// ------------------------------------------------------------ chopping block
async function renderLive() {
  const d = await api('/api/live');
  document.getElementById('league-name').textContent = d.league;
  document.title = `Week ${d.week}, ${d.league}`;
  const live = d.games.filter((g) => g.state === 'in').length;
  const final = d.games.filter((g) => g.state === 'post').length;
  const pre = d.games.length - live - final;
  let status;
  if (!d.games.length) status = 'No NFL games scheduled this week.';
  else if (live) status = `<span class="dot" aria-hidden="true"></span>${live} game${live > 1 ? 's' : ''} live. ${final} final, ${pre} to play.`;
  else if (!pre) status = 'Every game is final. The cut posts Tuesday morning.';
  else status = `${final} final, ${pre} to play. Next kickoff ${kick(d.games.find((g) => g.state === 'pre').kickoff)}.`;

  const n = d.alive.length;
  const safe = d.alive.slice(0, n - d.cuts);
  const doomed = d.alive.slice(n - d.cuts);
  const gap = safe.length && doomed.length ? safe[safe.length - 1].projected - doomed[0].projected : null;
  const row = (t, rank, cls) => `
    <li class="row ${cls}"><a href="#team/${t.id}">
      <span class="rank">${rank}</span>
      <span class="who"><span class="tname">${esc(t.name)}</span><span class="owner">${esc(t.owner)}</span></span>
      <span class="pips" title="Starters: ${t.pips.filter((p) => p === 'pre').length} to play, ${t.pips.filter((p) => p === 'in').length} playing, ${t.pips.filter((p) => p === 'post').length} done">${t.pips.map((p) => `<i class="pip ${p}"></i>`).join('')}</span>
      <span class="score"><b>${pts(t.points)}</b><small>${t.pips.some((x) => x === 'pre' || x === 'in') ? `proj ${pts(t.projected)}` : 'final'}</small></span>
    </a></li>`;

  $app.innerHTML = `
    <section class="masthead">
      <h1 class="week">Week ${d.week}</h1>
      <p class="status">${status}</p>
      <p class="muted">${n} teams alive, ${d.eliminated_count} cut. Stats updated ${ago(d.stats_updated)}.</p>
    </section>
    ${d.champion ? `<div class="champion">${esc(d.champion.name)} survived the season. Champion: ${esc(d.champion.owner)}.</div>` : ''}
    ${n ? `<ol class="block-list" aria-label="Teams ranked by projected score">
      ${safe.map((t, i) => row(t, i + 1, 'safe')).join('')}
      ${doomed.length ? `<li class="blade" role="separator" aria-label="Cut line">
        <span class="blade-steel" aria-hidden="true"></span>
        <span class="blade-text"><span class="blade-label">${d.cuts > 1 ? `Bottom ${d.cuts} get cut` : 'Cut line'}</span>
        <span class="blade-gap">${gap != null ? `${pts(gap)} ${live || pre ? 'projected ' : ''}points from safety` : ''}</span></span>
      </li>` : ''}
      ${doomed.map((t, i) => row(t, safe.length + i + 1, 'doomed')).join('')}
    </ol>` : `<div class="panel"><h3>No teams yet</h3><p>The commissioner can import owners and rosters from the Commissioner page.</p></div>`}
    <h2>NFL this week</h2>
    <div class="game-grid">${d.games.map((g) => `
      <div class="game ${g.state}">
        <div class="line"><b>${esc(g.away)}</b><span>${g.state === 'pre' ? '' : g.away_score}</span></div>
        <div class="line"><b>${esc(g.home)}</b><span>${g.state === 'pre' ? '' : g.home_score}</span></div>
        <div class="gdetail">${g.state === 'pre' ? kick(g.kickoff) : esc(g.detail)}</div>
      </div>`).join('')}</div>`;
}

// ------------------------------------------------------------ team page
async function renderTeam(id) {
  const d = await api(`/api/teams/${id}`);
  const own = d.is_owner && !d.team.eliminated_week;
  const t = d.team;
  document.title = t.name;

  const playerCell = (p) => `<button class="pname" data-player="${esc(p.id)}">${esc(p.name)}</button>${p.injury ? `<span class="inj">${esc(p.injury)}</span>` : ''}
    <div class="pmeta">${esc(p.pos)} ${esc(p.nfl || 'FA')}${p.locked ? ' <span class="locked">locked</span>' : ''}</div>`;
  const slotCell = (p) => {
    if (!own) return '';
    const opts = eligibleSlots(p.pos, d.slots, d.flex).map((s) => `<option ${s === p.slot ? 'selected' : ''}>${s}</option>`).join('');
    return `<td><select data-slot="${esc(p.id)}" aria-label="Slot for ${esc(p.name)}" ${p.locked ? 'disabled' : ''}>${opts}</select></td>`;
  };
  const dropCell = (p) => (own ? `<td class="r"><button class="btn sm danger" data-drop="${esc(p.id)}" data-name="${esc(p.name)}" ${p.locked ? 'disabled' : ''}>Drop</button></td>` : '');
  const prow = (p, slotLabel) => `<tr>
      <td class="slot">${esc(slotLabel)}</td>
      <td>${playerCell(p)}</td>
      <td class="hide-sm">${gameText(p.game)}</td>
      <td class="r pts">${pts(p.points)}</td>
      <td class="r hide-sm muted">${pts(p.proj)}</td>
      ${slotCell(p)}${dropCell(p)}
    </tr>`;

  // Starters in slot order, with empty slots shown.
  const starterRows = [];
  for (const [slot, count] of Object.entries(d.slots)) {
    if (slot === 'BN') continue;
    const inSlot = d.starters.filter((p) => p.slot === slot);
    for (let i = 0; i < count; i++) {
      const p = inSlot[i];
      starterRows.push(p ? prow(p, slot) : `<tr><td class="slot">${slot}</td><td class="empty-slot" colspan="${own ? 6 : 4}">Empty</td></tr>`);
    }
  }
  const head = `<thead><tr><th>Slot</th><th>Player</th><th class="hide-sm">Game</th><th class="r">Pts</th><th class="r hide-sm">Proj</th>${own ? '<th>Move to</th><th></th>' : ''}</tr></thead>`;
  const rosterCount = d.starters.length + d.bench.length;

  $app.innerHTML = `
    <section class="team-head">
      <h1>${esc(t.name)}</h1>
      <div class="facts">
        <span>${esc(t.owner)}</span>
        ${t.eliminated_week ? `<span class="badge cut">Cut in week ${t.eliminated_week}</span>` : '<span class="badge alive">Alive</span>'}
        <span>Week ${d.week}: <b class="num">${pts(t.points)}</b> (proj <span class="num">${pts(t.projected)}</span>)</span>
        <span>Season: <b class="num">${pts(t.season_total)}</b></span>
        <span>FAAB: <b class="num">$${t.faab}</b></span>
        <span>Roster: <b class="num">${rosterCount}/${d.roster_max}</b></span>
      </div>
    </section>
    ${t.eliminated_week ? '' : `
    <h2>Starters</h2>
    <div class="table-wrap"><table>${head}<tbody>${starterRows.join('')}</tbody></table></div>
    <h2>Bench</h2>
    <div class="table-wrap"><table>${head}<tbody>${d.bench.map((p) => prow(p, 'BN')).join('') || `<tr><td colspan="7" class="muted">No bench players.</td></tr>`}</tbody></table></div>
    ${own ? `<div class="toolbar"><button class="btn primary" id="save-lineup">Save lineup</button><a class="btn" href="#players">Find players</a></div>` : ''}`}
    ${own && d.claims.length ? `<h2>Your waiver bids</h2><div class="panel"><ul class="list">${d.claims.map((c) => `
      <li><span><b>${esc(c.player)}</b> <span class="muted">${esc(c.pos)} ${esc(c.nfl || '')}</span> for <b>$${c.bid}</b>${c.drop_name ? `, dropping ${esc(c.drop_name)}` : ''}
        <div class="pmeta">${c.status === 'pending' ? 'Pending until waivers run Wednesday' : esc(c.reason || c.status)}</div></span>
        ${c.status === 'pending' ? `<button class="btn sm" data-cancel="${c.id}">Cancel bid</button>` : `<span class="muted">${esc(c.status)}</span>`}
      </li>`).join('')}</ul></div>` : ''}
    ${d.history.length ? `<h2>Weekly results</h2><div class="panel"><ul class="list">${d.history.map((h) => `
      <li><span>Week ${h.week}${h.eliminated ? ' <span class="badge cut">Cut</span>' : ''}</span><span class="num">${pts(h.points)} <span class="muted">rank ${h.rank}</span></span></li>`).join('')}</ul></div>` : ''}
    ${d.is_owner ? '' : (state.me ? '' : `<p class="muted" style="margin-top:24px">Managing this team? Open the private link the commissioner sent you.</p>`)}`;

  bindPlayerLinks();
  if (!own) return;
  $app.querySelectorAll('select[data-slot]').forEach((s) => s.addEventListener('change', () => { state.dirty = true; }));
  document.getElementById('save-lineup')?.addEventListener('click', async () => {
    const slots = {};
    $app.querySelectorAll('select[data-slot]').forEach((s) => { slots[s.dataset.slot] = s.value; });
    if (await act(() => api('/api/me/lineup', { method: 'POST', body: { slots } }), 'Lineup saved')) { state.dirty = false; renderTeam(id); }
  });
  $app.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Drop ${b.dataset.name}? He goes to waivers.`)) return;
    if (await act(() => api('/api/me/drop', { method: 'POST', body: { player_id: b.dataset.drop } }), `${b.dataset.name} dropped`)) renderTeam(id);
  }));
  $app.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (await act(() => api(`/api/me/claims/${b.dataset.cancel}`, { method: 'DELETE' }), 'Bid canceled')) renderTeam(id);
  }));
}

// ------------------------------------------------------------ players
async function renderPlayers() {
  const f = state.filter;
  const qs = new URLSearchParams({ pos: f.pos, q: f.q, all: f.all ? '1' : '0' });
  const [d, mine] = await Promise.all([
    api(`/api/players?${qs}`),
    state.me && !state.me.eliminated_week ? api(`/api/teams/${state.me.id}`) : Promise.resolve(null),
  ]);
  const myRoster = mine ? [...mine.starters, ...mine.bench] : [];
  const dropOptions = `<option value="">No drop</option>${myRoster.map((p) => `<option value="${esc(p.id)}" ${p.locked ? 'disabled' : ''}>${esc(p.name)} (${esc(p.pos)})${p.locked ? ' locked' : ''}</option>`).join('')}`;
  const canAct = !!mine;

  const statusOf = (p) => (p.fantasy_team ? esc(p.fantasy_team) : p.on_waivers || !d.instant_free_agents ? 'Waivers' : 'Free agent');
  const actionOf = (p) => {
    if (!canAct || p.fantasy_team) return '';
    const waiver = p.on_waivers || !d.instant_free_agents;
    return `<button class="btn sm" data-open="${esc(p.id)}" ${!waiver && p.locked ? 'disabled title="Game has started"' : ''}>${waiver ? 'Bid' : 'Add'}</button>`;
  };
  const formRow = (p) => {
    const waiver = p.on_waivers || !d.instant_free_agents;
    return `<tr class="form-row"><td colspan="6"><div class="inline-form">
      ${waiver ? `<label>Bid (you have $${mine.team.faab})<input type="number" min="0" max="${mine.team.faab}" step="1" value="0" id="bid-amt" style="width:110px"></label>` : ''}
      <label>Drop<select id="bid-drop">${dropOptions}</select></label>
      <button class="btn primary" data-submit="${esc(p.id)}" data-waiver="${waiver ? 1 : 0}" data-name="${esc(p.name)}">${waiver ? 'Place bid' : 'Add player'}</button>
      <button class="btn" data-close>Cancel</button>
    </div></td></tr>`;
  };

  $app.innerHTML = `
    <section class="team-head"><h1>Players</h1>
      <p class="muted">${canAct ? 'Players released by cut teams and recent drops are on waivers until Wednesday. Bids are blind and the highest one wins.' : 'Open your team link to add players and place bids.'}</p>
    </section>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search by name" value="${esc(f.q)}" aria-label="Search players">
      <div class="seg" role="group" aria-label="Position">${['', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) => `<button data-pos="${p}" aria-pressed="${f.pos === p}">${p || 'All'}</button>`).join('')}</div>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="all" ${f.all ? 'checked' : ''}> Include rostered</label>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Player</th><th class="hide-sm">Game</th><th>Status</th><th class="r">Wk ${d.week}</th><th class="r">Proj</th><th></th></tr></thead>
      <tbody>${d.players.map((p) => `<tr>
        <td><button class="pname" data-player="${esc(p.id)}">${esc(p.name)}</button>${p.injury ? `<span class="inj">${esc(p.injury)}</span>` : ''}<div class="pmeta">${esc(p.pos)} ${esc(p.nfl || 'FA')}</div></td>
        <td class="hide-sm">${gameText(p.game)}</td>
        <td>${statusOf(p)}</td>
        <td class="r pts">${pts(p.points)}</td>
        <td class="r muted">${pts(p.proj)}</td>
        <td class="r">${actionOf(p)}</td>
      </tr>${state.openRow === p.id ? formRow(p) : ''}`).join('') || '<tr><td colspan="6" class="muted">No players match. Try another name or position.</td></tr>'}</tbody>
    </table></div>`;

  bindPlayerLinks();
  let deb;
  const q = document.getElementById('q');
  q.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { f.q = q.value; state.openRow = null; renderPlayers().then(() => { const el = document.getElementById('q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); }, 300); });
  $app.querySelectorAll('[data-pos]').forEach((b) => b.addEventListener('click', () => { f.pos = b.dataset.pos; state.openRow = null; renderPlayers(); }));
  document.getElementById('all').addEventListener('change', (e) => { f.all = e.target.checked; renderPlayers(); });
  $app.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { state.openRow = b.dataset.open; renderPlayers(); }));
  $app.querySelector('[data-close]')?.addEventListener('click', () => { state.openRow = null; renderPlayers(); });
  $app.querySelector('[data-submit]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    const drop = document.getElementById('bid-drop').value || null;
    const ok = b.dataset.waiver === '1'
      ? await act(() => api('/api/me/claims', { method: 'POST', body: { player_id: b.dataset.submit, drop_player_id: drop, bid: Number(document.getElementById('bid-amt').value) } }), `Bid placed on ${b.dataset.name}`)
      : await act(() => api('/api/me/add', { method: 'POST', body: { player_id: b.dataset.submit, drop_player_id: drop } }), `${b.dataset.name} added`);
    if (ok) { state.openRow = null; await loadMe(); renderPlayers(); }
  });
}

function bindPlayerLinks() {
  $app.querySelectorAll('[data-player]').forEach((b) => b.addEventListener('click', () => showPlayer(b.dataset.player)));
}

async function showPlayer(id) {
  const dlg = document.getElementById('player-dialog');
  const body = document.getElementById('player-dialog-body');
  body.innerHTML = '<p class="muted">Loading stats</p>';
  dlg.showModal();
  try {
    const d = await api(`/api/players/${encodeURIComponent(id)}`);
    const p = d.player;
    body.innerHTML = `
      <h2 id="pd-title">${esc(p.name)}</h2>
      <p class="muted">${esc(p.pos)} ${esc(p.nfl || 'FA')}${p.injury ? `, ${esc(p.injury)}` : ''}${p.fantasy_team ? `. On ${esc(p.fantasy_team)}` : '. Unrostered'}</p>
      <p>Week ${d.week}: <b class="num">${pts(d.points)}</b> points, projected <span class="num">${pts(d.proj)}</span>${d.preset !== 'custom' ? ` (${esc(d.preset.replace('_', ' '))} scoring)` : ''}.</p>
      ${d.breakdown.length ? `<div class="table-wrap"><table><thead><tr><th>Stat</th><th class="r">Value</th><th class="r">Pts each</th><th class="r">Pts</th></tr></thead><tbody>
        ${d.breakdown.map((b) => `<tr><td>${esc(STAT_LABELS[b.key] || b.key)} <span class="pmeta">${esc(b.key)}</span></td><td class="r">${b.value}</td><td class="r muted">${b.weight ?? ''}</td><td class="r">${b.points != null ? pts(b.points) : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No stats yet this week.</p>'}`;
  } catch (e) { body.innerHTML = `<p>${esc(e.message)}</p>`; }
}

// ------------------------------------------------------------ graveyard / activity
async function renderGraveyard() {
  const d = await api('/api/graveyard');
  $app.innerHTML = `<section class="team-head"><h1>Graveyard</h1><p class="muted">Every team that lost its head, most recent first.</p></section>
    ${d.teams.length ? `<div class="panel"><ul class="list grave">${d.teams.map((t) => `
      <li><span class="gw">Week ${t.eliminated_week}</span><span style="flex:1"><a href="#team/${t.id}" class="gname">${esc(t.name)}</a> <span class="muted">${esc(t.owner)}</span></span><span class="num">${t.points != null ? pts(t.points) : ''}</span></li>`).join('')}</ul></div>`
    : '<div class="panel"><p>Nobody has been cut yet. The first cut happens after the current week goes final.</p></div>'}`;
}

async function renderActivity() {
  const d = await api('/api/activity');
  const label = { add: 'Added', drop: 'Dropped', waiver: 'Won on waivers', eliminated: 'Cut', import: 'League import' };
  $app.innerHTML = `<section class="team-head"><h1>Activity</h1></section>
    ${d.items.length ? `<div class="panel"><ul class="list">${d.items.map((x) => `
      <li><span><b>${esc(x.team || 'League')}</b> ${esc(label[x.type] || x.type)} ${x.player ? `<b>${esc(x.player)}</b> <span class="muted">${esc(x.pos || '')}</span>` : ''} ${x.detail ? `<span class="muted">${esc(x.detail)}</span>` : ''}</span>
      <span class="muted" style="white-space:nowrap">${new Date(`${x.created_at.replace(' ', 'T')}Z`).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></li>`).join('')}</ul></div>`
    : '<div class="panel"><p>No moves yet.</p></div>'}`;
}

// ------------------------------------------------------------ commissioner
// One request per position keeps each Worker run small enough for the free plan.
async function syncAllPlayers(onStep) {
  let total = 0;
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
    if (onStep) onStep(pos);
    total += (await api('/api/admin/sync', { method: 'POST', admin: true, body: { what: 'players', pos } })).players;
  }
  return { ok: true, players: total };
}

async function renderAdmin() {
  if (!state.adminKey) return adminLogin();
  let d;
  try { d = await api('/api/admin/overview', { admin: true }); } catch (e) {
    if (e.status === 401) { state.adminKey = ''; localStorage.removeItem('gl_admin'); return adminLogin(e.message); }
    throw e;
  }
  const s = d.settings;
  const link = (t) => `${location.origin}/#join/${t.token}`;
  $app.innerHTML = `
    <section class="team-head"><h1>Commissioner</h1>
      <p class="muted">Season ${s.season}, week ${s.current_week}. ${d.player_count} NFL players loaded. ${d.pending_claims} pending bids.
      Synced: players ${ago(d.synced.players)}, games ${ago(d.synced.games)}, stats ${ago(d.synced.stats)}.</p></section>

    <div class="panel"><h3>Weekly operations</h3>
      <p class="muted">These run automatically: live stats every 2 minutes, the player list daily, the cut Tuesday from 10:00 UTC once every game is final, waivers Wednesday from 16:00 UTC.</p>
      <div class="toolbar">
        <button class="btn" data-op="sync">Sync live stats now</button>
        <button class="btn" data-op="players">Sync NFL player list</button>
        <button class="btn" data-op="waivers">Process waivers now</button>
        <button class="btn danger" data-op="finalize">Finalize week ${s.current_week} and cut</button>
        <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="force"> Cut even if games aren't final</label>
      </div>
      <div id="op-result"></div>
    </div>

    <div class="panel"><h3>Import owners and rosters</h3>
      <p class="muted">CSV columns: team, owner, email, player, pos, nfl_team, slot, faab, player_id. One row per player. Only team is required; owner and email can sit on any row. Leave slot blank to auto-fill each lineup by projection.</p>
      <textarea id="csv" rows="8" placeholder="team,owner,email,player,pos,nfl_team,slot&#10;Heads Will Roll,Brad,brad@example.com,Josh Allen,QB,BUF,QB"></textarea>
      <div class="toolbar">
        <label class="btn" style="display:inline-flex">Load CSV file<input type="file" id="csv-file" accept=".csv,text/csv" hidden></label>
        <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="replace"> Replace all existing teams</label>
        <button class="btn primary" id="do-import">Import</button>
      </div>
      <div id="import-result"></div>
    </div>

    <div class="panel"><h3>Teams and owner links</h3>
      <p class="muted">Send each owner their private link. Anyone with it can manage that team.</p>
      <div class="table-wrap"><table><thead><tr><th>Team</th><th>Owner</th><th class="r">FAAB</th><th class="r">Roster</th><th>Status</th><th></th></tr></thead><tbody>
      ${d.teams.map((t) => `<tr><td><a href="#team/${t.id}">${esc(t.name)}</a></td><td>${esc(t.owner)}<div class="pmeta">${esc(t.email || '')}</div></td>
        <td class="r">$${t.faab}</td><td class="r">${t.roster_size}</td><td>${t.eliminated_week ? `Cut wk ${t.eliminated_week}` : 'Alive'}</td>
        <td class="r" style="white-space:nowrap"><button class="btn sm" data-copy="${esc(link(t))}">Copy link</button> <button class="btn sm" data-regen="${t.id}">New link</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No teams yet. Import a CSV above.</td></tr>'}
      </tbody></table></div>
    </div>

    <div class="panel"><h3>League settings</h3>
      <p class="muted">Scoring weights use Sleeper stat keys. Set scoring.preset to ppr, half_ppr or std to use standard scoring instead of the weights. Click any player's name to see which stat keys he has. Saving re-pulls this week's stats.</p>
      <textarea id="settings" rows="22">${esc(JSON.stringify(s, null, 2))}</textarea>
      <div class="toolbar"><button class="btn primary" id="save-settings">Save settings</button></div>
    </div>

    <div class="panel"><h3>Reset</h3>
      <p class="muted">Deletes teams, rosters, bids, results and activity. NFL players and stats stay.</p>
      <div class="toolbar"><input id="reset-confirm" placeholder="Type RESET"><button class="btn danger" id="do-reset">Reset league</button>
      <button class="btn" id="sign-out">Sign out of commissioner</button></div>
    </div>`;

  const out = document.getElementById('op-result');
  $app.querySelectorAll('[data-op]').forEach((b) => b.addEventListener('click', async () => {
    const op = b.dataset.op;
    if (op === 'finalize' && !confirm(`Finalize week ${s.current_week}? The lowest score gets cut and their players go to waivers.`)) return;
    b.disabled = true;
    out.innerHTML = '<p class="muted">Working</p>';
    try {
      let r;
      if (op === 'sync') r = await api('/api/admin/sync', { method: 'POST', admin: true, body: { what: 'live' } });
      if (op === 'players') r = await syncAllPlayers((pos) => { out.innerHTML = `<p class="muted">Loading ${pos}s</p>`; });
      if (op === 'waivers') r = await api('/api/admin/waivers', { method: 'POST', admin: true, body: {} });
      if (op === 'finalize') r = await api('/api/admin/finalize', { method: 'POST', admin: true, body: { force: document.getElementById('force').checked } });
      toast('Done');
      await renderAdmin();
      document.getElementById('op-result').innerHTML = `<pre class="muted" style="white-space:pre-wrap">${esc(JSON.stringify(r, null, 2))}</pre>`;
    } catch (e) { out.innerHTML = `<p style="color:var(--blood)">${esc(e.message)}</p>`; b.disabled = false; }
  }));

  document.getElementById('csv-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) document.getElementById('csv').value = await f.text();
  });
  document.getElementById('do-import').addEventListener('click', async () => {
    const csv = document.getElementById('csv').value.trim();
    if (!csv) return toast('Paste CSV rows or load a file first.', 'error');
    const replace = document.getElementById('replace').checked;
    if (replace && !confirm('Replace every existing team and roster?')) return;
    const res = document.getElementById('import-result');
    try {
      if (!d.player_count) await syncAllPlayers((pos) => { res.innerHTML = `<p class="muted">Loading the NFL player list first: ${pos}s</p>`; });
      res.innerHTML = '<p class="muted">Importing</p>';
      const r = await api('/api/admin/import', { method: 'POST', admin: true, body: { csv, replace } });
      await renderAdmin();
      document.getElementById('import-result').innerHTML = `
        <p>Imported ${r.teams.length} teams.</p>
        ${r.unmatched.length ? `<p style="color:var(--blood)">${r.unmatched.length} players didn't match. Add a player_id (Sleeper ID) or nfl_team to these rows and import again:</p>
          <ul>${r.unmatched.map((u) => `<li>${esc(u.team)}: ${esc(u.player)} ${esc(u.pos)} ${esc(u.nfl)} ${u.note ? `(${esc(u.note)})` : ''}</li>`).join('')}</ul>` : ''}`;
    } catch (e) { res.innerHTML = `<p style="color:var(--blood)">${esc(e.message)}</p>`; }
  });

  $app.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Link copied'); } catch { prompt('Copy this link', b.dataset.copy); }
  }));
  $app.querySelectorAll('[data-regen]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Create a new link? The old one stops working.')) return;
    if (await act(() => api(`/api/admin/teams/${b.dataset.regen}/token`, { method: 'POST', admin: true, body: {} }), 'New link created')) renderAdmin();
  }));
  document.getElementById('save-settings').addEventListener('click', async () => {
    let parsed;
    try { parsed = JSON.parse(document.getElementById('settings').value); } catch (e) { return toast(`Settings aren't valid JSON: ${e.message}`, 'error'); }
    if (await act(() => api('/api/admin/settings', { method: 'PUT', admin: true, body: { settings: parsed } }), 'Settings saved')) renderAdmin();
  });
  document.getElementById('do-reset').addEventListener('click', async () => {
    const confirmText = document.getElementById('reset-confirm').value;
    if (await act(() => api('/api/admin/reset', { method: 'POST', admin: true, body: { confirm: confirmText } }), 'League reset')) renderAdmin();
  });
  document.getElementById('sign-out').addEventListener('click', () => { state.adminKey = ''; localStorage.removeItem('gl_admin'); renderAdmin(); });
}

function adminLogin(msg = '') {
  $app.innerHTML = `<section class="team-head"><h1>Commissioner</h1></section>
    <div class="panel"><form id="admin-login" class="inline-form">
      <label>Commissioner key<input type="password" id="admin-key" autocomplete="current-password" required></label>
      <button class="btn primary">Sign in</button></form>
      ${msg ? `<p style="color:var(--blood)">${esc(msg)}</p>` : ''}</div>`;
  document.getElementById('admin-login').addEventListener('submit', (e) => {
    e.preventDefault();
    state.adminKey = document.getElementById('admin-key').value;
    localStorage.setItem('gl_admin', state.adminKey);
    renderAdmin().catch((err) => toast(err.message, 'error'));
  });
}

// ------------------------------------------------------------ boot
window.addEventListener('hashchange', () => { state.openRow = null; router(); });
loadMe().finally(router);
