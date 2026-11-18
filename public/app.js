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
  editTeam: null,
  firstWeek: 1,
  online: { owners: [], guests: 0 },
  presenceOpen: false,
};
// Upcoming bye, in league week numbers. Shows nothing once the bye has passed.
const byeText = (byes, nfl, currentWeek) => {
  const w = byes && nfl ? byes[nfl] : null;
  if (!w || w < currentWeek) return '';
  return w === currentWeek ? ', <b class="bye-now">bye this week</b>' : `, bye wk ${lw(w)}`;
};
// League week number for an NFL week (first_week is the NFL week that was the league's Week 1).
const lw = (w) => Number(w) - (state.firstWeek || 1) + 1;

const STAT_LABELS = {
  pass_yd: 'Passing yards', pass_td: 'Passing TD', pass_int: 'Interceptions thrown', pass_2pt: 'Passing 2-pt',
  pass_att: 'Pass attempts', pass_cmp: 'Completions', rush_att: 'Rush attempts', rush_yd: 'Rushing yards',
  rush_td: 'Rushing TD', rush_2pt: 'Rushing 2-pt', rec_tgt: 'Targets', rec: 'Receptions', rec_yd: 'Receiving yards',
  rec_td: 'Receiving TD', rec_2pt: 'Receiving 2-pt', fum_lost: 'Fumbles lost', st_td: 'Return TD', gp: 'Games played',
  fgm: 'FG made', fga: 'FG attempts', xpm: 'XP made', xpa: 'XP attempts', fgmiss: 'FG missed', xpmiss: 'XP missed',
  fgm_0_19: 'FG 0-19', fgm_20_29: 'FG 20-29', fgm_30_39: 'FG 30-39', fgm_40_49: 'FG 40-49', fgm_50p: 'FG 50+',
  sack: 'Sacks', int: 'Interceptions', fum_rec: 'Fumble recoveries', def_td: 'Defensive TD', def_st_td: 'Def/ST TD',
  safe: 'Safeties', blk_kick: 'Blocked kicks', pts_allow: 'Points allowed', yds_allow: 'Yards allowed',
  fum_rec_td: 'Fumble return TD', def_kr_yd: 'Kick return yards', def_pr_yd: 'Punt return yards', def_st_td: 'Return TD',
  def_2pt: 'Extra point returned', pts_allow_0: 'Shutout', pts_allow_1_6: 'Allowed 1-6', pts_allow_7_13: 'Allowed 7-13', pts_allow_14_20: 'Allowed 14-20',
  'pass_yd 300+ bonus': '300+ passing yards', 'pass_yd 600+ bonus': '600+ passing yards',
  'rush_yd 100+ bonus': '100+ rushing yards', 'rush_yd 200+ bonus': '200+ rushing yards', 'rush_yd 300+ bonus': '300+ rushing yards',
  'rec_yd 100+ bonus': '100+ receiving yards', 'rec_yd 200+ bonus': '200+ receiving yards', 'rec_yd 300+ bonus': '300+ receiving yards',
  'yds_allow 0-99': 'Allowed 0-99 yards', 'yds_allow 100-199': 'Allowed 100-199 yards', 'yds_allow 200-299': 'Allowed 200-299 yards',
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
const shortAgo = (ms) => {
  if (!ms) return 'Not yet';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
  return Object.keys(slots).filter((s) => s === 'BN' || (Number(slots[s]) > 0 && (flex[s] ? flex[s].includes(pos) : s === pos)));
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

const ICONS = {
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  blade: '<path d="M4 3h16M6 3v18M18 3v18M3 21h18"/><path d="M8 6h8l-8 5z"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  wallet: '<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20M16 15h2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
};
const tiles = (items, cls = '') => `<div class="stat-tiles ${cls}">${items.map((t) => `
  <div class="stat-card"><div class="stat-icon ${t.color}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[t.icon]}</svg></div>
  <div><div class="stat-value">${t.value}</div><div class="stat-label">${t.label}</div></div></div>`).join('')}</div>`;

// ------------------------------------------------------------ presence (who's online)
const VID = (() => {
  let v = localStorage.getItem('gl_vid');
  if (!v) { v = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()) + Date.now()).replace(/[^a-z0-9]/gi, '').slice(0, 24); localStorage.setItem('gl_vid', v); }
  return v;
})();
const PAGE_LABEL = { live: 'Watching the Chopping Block', team: 'Looking at a team', players: 'Browsing players', graveyard: 'Visiting the Graveyard', activity: 'Reading Activity' };
const AVATAR_COLORS = ['#007CBC', '#5FA845', '#E8536A', '#9A6A12', '#4E8DF5', '#0B2A38', '#00618f', '#4c8637'];
const initials = (o) => (o.owner || o.team || '?').split(/\s+/).map((w) => (w.match(/[a-z0-9]/i) || [''])[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
const avatar = (o) => (o.logo_v
  ? `<img class="avatar" src="/api/logos/${o.team_id}?v=${o.logo_v}" alt="">`
  : `<span class="avatar" style="background:${AVATAR_COLORS[o.team_id % AVATAR_COLORS.length]}" aria-hidden="true">${esc(initials(o))}</span>`);
// Team logo, or a colored initials tile when there isn't one.
const teamLogo = (id, v, name, size = '') => (v
  ? `<img class="tlogo ${size}" src="/api/logos/${id}?v=${v}" alt="" loading="lazy">`
  : `<span class="tlogo ${size} tlogo-fallback" style="background:${AVATAR_COLORS[id % AVATAR_COLORS.length]}" aria-hidden="true">${esc(initials({ team: name }))}</span>`);

// Shrink an uploaded image to a 256px square (whole image kept, centered) before sending it.
async function imageToLogo(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Choose an image file (PNG, JPG, WebP or SVG).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("That image couldn't be read. Try a PNG or JPG."));
      i.src = url;
    });
    const size = 256;
    const draw = (bg) => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      if (bg) { g.fillStyle = bg; g.fillRect(0, 0, size, size); }
      const w = img.naturalWidth || size;
      const h = img.naturalHeight || size;
      const k = Math.min(size / w, size / h);
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, (size - w * k) / 2, (size - h * k) / 2, w * k, h * k);
      return c;
    };
    let data = draw(null).toDataURL('image/webp', 0.86);
    if (!data.startsWith('data:image/webp')) data = draw('#ffffff').toDataURL('image/jpeg', 0.88); // browsers without WebP encoding
    return data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const isOnline = (teamId) => state.online.owners.some((o) => o.team_id === teamId);

async function heartbeat() {
  if (document.hidden) return;
  const view = (location.hash.slice(1) || 'live').split('/')[0];
  try {
    state.online = await api('/api/presence', { method: 'POST', body: { vid: VID, page: view === 'admin' ? 'live' : view } });
    renderPresence();
  } catch { /* presence is best-effort */ }
}

function renderPresence() {
  const el = document.getElementById('presence');
  const { owners, guests } = state.online;
  const others = owners.filter((o) => !state.me || o.team_id !== state.me.id);
  const total = owners.length + guests;
  if (!total) { el.innerHTML = ''; return; }
  const shown = owners.slice(0, 4);
  const extra = owners.length - shown.length;
  const label = others.length ? `${others.length} other owner${others.length > 1 ? 's' : ''} online` : (guests ? `${total} viewing` : 'Just you');
  el.innerHTML = `
    <button class="presence-btn ${shown.length ? '' : 'solo'}" id="presence-btn" aria-expanded="${state.presenceOpen}" aria-controls="presence-pop">
      ${shown.length ? `<span class="avatars">${shown.map(avatar).join('')}${extra > 0 ? `<span class="avatar more">+${extra}</span>` : ''}</span>` : '<span class="live-dot" aria-hidden="true"></span>'}
      <span class="pl-long">${label}</span><span class="pl-short">${total} online</span>
    </button>
    ${state.presenceOpen ? `<div class="presence-pop" id="presence-pop">
      <h4>Online now</h4>
      <ul>${owners.map((o) => `<li><a href="#team/${o.team_id}">${avatar(o)}<span style="min-width:0">
        <span class="pp-name">${esc(o.owner || o.team)}${state.me && o.team_id === state.me.id ? ' (you)' : ''}</span>
        <div class="pp-sub">${o.owner ? `${esc(o.team)}. ` : ''}${esc(PAGE_LABEL[o.page] || 'Browsing')}</div></span></a></li>`).join('') || '<li class="muted" style="font-size:12px">No owners online yet.</li>'}</ul>
      ${guests ? `<div class="pp-guests">${guests} guest${guests > 1 ? 's' : ''} watching without a team link</div>` : ''}
    </div>` : ''}`;
  document.getElementById('presence-btn').onclick = (e) => { e.stopPropagation(); state.presenceOpen = !state.presenceOpen; renderPresence(); };
  // Green dots next to team names that are online right now.
  document.querySelectorAll('[data-team-id]').forEach((n) => n.classList.toggle('is-online', isOnline(Number(n.dataset.teamId))));
}
document.addEventListener('click', (e) => {
  if (state.presenceOpen && !e.target.closest('#presence')) { state.presenceOpen = false; renderPresence(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) heartbeat(); });
setInterval(heartbeat, 45000);

// ------------------------------------------------------------ player news
const newsWhen = (iso) => {
  const h = (Date.now() - Date.parse(iso)) / 3600e3;
  if (h < 1) return 'Just now';
  if (h < 24) return `${Math.round(h)}h ago`;
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};
const newsItem = (n, withPlayer) => `<li class="news-item">
  <div class="news-meta">${withPlayer ? `<button class="pname" data-player="${esc(n.player_id)}">${esc(n.player)}</button> <span class="pmeta">${esc(n.pos)} ${esc(n.nfl || '')}</span> ` : ''}<span class="pmeta">${newsWhen(n.published)}</span></div>
  <div class="news-head">${esc(n.headline)}</div>
  ${n.story ? `<details><summary>Analysis</summary><p>${esc(n.story)}</p></details>` : ''}
</li>`;

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
  document.querySelectorAll('.top-nav a').forEach((a) => {
    const current = a.dataset.view === view || (a.dataset.view === 'mine' && view === 'team' && state.me && Number(arg) === state.me.id);
    if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  state.dirty = false;
  try {
    if (view === 'live') { await renderLive(); state.timer = setInterval(() => renderLive().catch(() => {}), 30000); }
    else if (view === 'team') { await renderTeam(Number(arg)); state.timer = setInterval(() => { if (!state.dirty && !state.openRow) renderTeam(Number(arg)).catch(() => {}); }, 30000); }
    else if (view === 'players') await renderPlayers();
    else if (view === 'graveyard') { location.replace('#live'); return; }
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
  const [d, gy] = await Promise.all([api('/api/live'), api('/api/graveyard')]);
  state.firstWeek = d.first_week || 1;
  document.getElementById('league-name').textContent = d.league;
  document.title = `Week ${lw(d.week)}, ${d.league}`;
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
    <li class="row ${cls} ${isOnline(t.id) ? 'is-online' : ''}" data-team-id="${t.id}"><a href="#team/${t.id}">
      <span class="rank">${rank}</span>
      ${teamLogo(t.id, t.logo_v, t.name)}
      <span class="who"><span class="tname">${esc(t.name)}<i class="on-dot" title="Online now"></i></span><span class="owner">${esc(t.owner)}</span></span>
      <span class="pips" title="Starters: ${t.pips.filter((p) => p === 'pre').length} to play, ${t.pips.filter((p) => p === 'in').length} playing, ${t.pips.filter((p) => p === 'post').length} done">${t.pips.map((p) => `<i class="pip ${p}"></i>`).join('')}</span>
      <span class="score"><b>${pts(t.points)}</b><small>${t.pips.some((x) => x === 'pre' || x === 'in') ? `proj ${pts(t.projected)}` : 'final'}</small></span>
    </a></li>`;

  $app.innerHTML = `
    <img class="banner" src="/banner-btf.jpg" srcset="/banner-btf-1200.jpg 1200w, /banner-btf.jpg 2400w" sizes="(max-width: 1180px) 100vw, 1124px"
      width="2400" height="480" alt="Brad Tharp &amp; Friends Fantasy Football League">
    <section class="hero">
      <h1>Week ${lw(d.week)} <em>Chopping Block</em></h1>
      <p>${status}</p>
    </section>
    ${tiles([
      { icon: 'users', color: 'blue', value: n, label: 'Teams alive' },
      { icon: 'blade', color: 'red', value: d.eliminated_count, label: 'Teams cut' },
      { icon: 'play', color: 'green', value: `${final}/${d.games.length}`, label: live ? `Games final, ${live} live now` : 'Games final' },
      { icon: 'clock', color: 'gold', value: shortAgo(d.stats_updated), label: 'Stats updated' },
    ])}
    ${d.champion ? `<div class="champion">${esc(d.champion.name)} survived the season. Champion: ${esc(d.champion.owner)}.</div>` : ''}
    ${n ? `<div class="block-card"><ol class="block-list" aria-label="Teams ranked by projected score">
      ${safe.map((t, i) => row(t, i + 1, 'safe')).join('')}
      ${doomed.length ? `<li class="blade" role="separator" aria-label="Cut line">
        <span class="blade-steel" aria-hidden="true"></span>
        <span class="blade-text"><span class="blade-label">${d.cuts > 1 ? `Bottom ${d.cuts} get cut` : 'Cut line'}</span>
        <span class="blade-gap">${gap != null ? `${pts(gap)} ${live || pre ? 'projected ' : ''}points from safety` : ''}</span></span>
      </li>` : ''}
      ${doomed.map((t, i) => row(t, safe.length + i + 1, 'doomed')).join('')}
    </ol></div>` : `<div class="panel"><h3>No teams yet</h3><p>The commissioner can import owners and rosters from the Commissioner page.</p></div>`}
    <h2 id="chopped">Chopped</h2>
    ${gy.teams.length ? `<div class="panel"><ul class="list grave">${gy.teams.map((t) => `
      <li><span class="gw">Week ${lw(t.eliminated_week)}</span><span style="flex:1;display:flex;align-items:center;gap:10px">${teamLogo(t.id, t.logo_v, t.name, 'sm')}<span><a href="#team/${t.id}" class="gname">${esc(t.name)}</a> <span class="muted">${esc(t.owner)}</span></span></span><span class="num">${t.points != null ? pts(t.points) : ''}</span></li>`).join('')}</ul></div>`
    : '<div class="panel"><p class="muted">Nobody has been chopped yet. The first cut happens after the current week goes final.</p></div>'}`;
}

// ------------------------------------------------------------ team page
async function renderTeam(id) {
  const d = await api(`/api/teams/${id}`);
  state.firstWeek = d.first_week || 1;
  const own = d.is_owner && !d.team.eliminated_week;
  const t = d.team;
  document.title = t.name;

  const playerCell = (p) => `<button class="pname" data-player="${esc(p.id)}">${esc(p.name)}</button>${p.injury ? `<span class="inj">${esc(p.injury)}</span>` : ''}
    <div class="pmeta">${esc(p.pos)} ${esc(p.nfl || 'FA')}${byeText(d.byes, p.nfl, d.week)}${p.locked ? ' <span class="locked">locked</span>' : ''}</div>
    <div class="pmeta show-sm">${gameText(p.game)}</div>`;
  const slotCell = (p) => {
    if (!own) return '';
    const cur = Number(d.slots[p.slot]) > 0 ? p.slot : 'BN';
    const choices = eligibleSlots(p.pos, d.slots, d.flex).filter((s) => s !== 'IR');
    if (d.ir_max > 0 && (p.slot === 'IR' || (p.injury && d.ir_statuses.includes(p.injury)))) choices.push('IR');
    const opts = choices.map((s) => `<option ${s === cur ? 'selected' : ''}>${s}</option>`).join('');
    return `<td><select data-slot="${esc(p.id)}" aria-label="Slot for ${esc(p.name)}" ${p.locked ? 'disabled' : ''}>${opts}</select></td>`;
  };
  const dropCell = (p) => (own ? `<td class="r"><button class="btn sm danger" data-drop="${esc(p.id)}" data-name="${esc(p.name)}" ${p.locked ? 'disabled' : ''}>Drop</button></td>` : '');
  const prow = (p, slotLabel) => `<tr>
      <td class="slot">${esc(slotLabel)}</td>
      <td>${playerCell(p)}</td>
      <td class="hide-sm">${gameText(p.game)}</td>
      <td class="r pts">${pts(p.points)}<div class="pmeta show-sm">proj ${pts(p.proj)}</div><div class="pmeta show-sm">season ${pts(p.season_pts)}</div></td>
      <td class="r hide-sm muted">${pts(p.proj)}</td>
      <td class="r hide-sm muted">${pts(p.season_pts)}</td>
      ${slotCell(p)}${dropCell(p)}
    </tr>`;

  // Starters in slot order, with empty slots shown.
  const starterRows = [];
  for (const [slot, count] of Object.entries(d.slots)) {
    if (slot === 'BN' || slot === 'IR') continue;
    const inSlot = d.starters.filter((p) => p.slot === slot);
    for (let i = 0; i < count; i++) {
      const p = inSlot[i];
      starterRows.push(p ? prow(p, slot) : `<tr><td class="slot">${slot}</td><td class="empty-slot" colspan="${own ? 7 : 5}">Empty</td></tr>`);
    }
  }
  const head = `<thead><tr><th>Slot</th><th>Player</th><th class="hide-sm">Game</th><th class="r">Pts</th><th class="r hide-sm">Proj</th><th class="r hide-sm">Season</th>${own ? '<th>Move to</th><th></th>' : ''}</tr></thead>`;
  const irPlayers = d.bench.filter((p) => p.slot === 'IR');
  const benchPlayers = d.bench.filter((p) => p.slot !== 'IR');
  const rosterCount = d.starters.length + benchPlayers.length;
  const over = rosterCount - d.roster_max;

  $app.innerHTML = `
    <section class="team-top">
      <div class="team-id">
        ${teamLogo(t.id, t.logo_v, t.name, 'xl')}
        <div class="team-id-text">
          <h1>${esc(t.name)}</h1>
          <p>${esc(t.owner)} ${isOnline(t.id) ? '<span class="online-chip"><span class="live-dot"></span>Online now</span>' : ''} ${t.eliminated_week ? `<span class="badge cut">Cut in week ${lw(t.eliminated_week)}</span>` : '<span class="badge alive">Alive</span>'}</p>
          ${d.is_owner ? `<div class="logo-tools">
            <label class="btn sm">${t.logo_v ? 'Change logo' : 'Add a team logo'}<input type="file" id="logo-file" accept="image/*" hidden></label>
            ${t.logo_v ? '<button class="btn sm danger" id="logo-remove">Remove logo</button>' : ''}
          </div>` : ''}
        </div>
      </div>
      ${tiles([
        { icon: 'chart', color: 'blue', value: `${pts(t.points)}<span class="stat-proj">proj ${pts(t.projected)}</span>`, label: `Week ${lw(d.week)} points` },
        { icon: 'trophy', color: 'gold', value: pts(t.season_total), label: 'Season total' },
        { icon: 'wallet', color: 'navy', value: `$${t.faab}`, label: 'FAAB left' },
        { icon: 'list', color: 'red', value: `${rosterCount}/${d.roster_max}`, label: d.ir_max ? `Active, ${irPlayers.length}/${d.ir_max} IR` : 'Roster spots' },
      ], 'team-tiles')}
    </section>
    ${!t.eliminated_week && over > 0 ? `<div class="over-limit"><b>Over the roster limit.</b> This team has ${rosterCount} active players and the limit is ${d.roster_max}.
      ${own ? `Drop ${over} player${over > 1 ? 's' : ''} or move an injured player to IR before adding anyone.` : 'The owner needs to drop players before adding anyone.'}</div>` : ''}
    ${t.eliminated_week ? '' : `
    <h2>Starters</h2>
    <div class="table-wrap"><table>${head}<tbody>${starterRows.join('')}</tbody></table></div>
    <h2>Bench</h2>
    <div class="table-wrap"><table>${head}<tbody>${benchPlayers.map((p) => prow(p, 'BN')).join('') || `<tr><td colspan="8" class="muted">No bench players.</td></tr>`}</tbody></table></div>
    ${d.ir_max ? `<h2>Injured reserve <span class="muted" style="font-size:13px;font-weight:500">Doesn't count toward the ${d.roster_max}. For players listed ${esc(d.ir_statuses.join(', '))}.</span></h2>
    <div class="table-wrap"><table>${head}<tbody>${irPlayers.map((p) => prow(p, 'IR')).join('')}${Array.from({ length: Math.max(0, d.ir_max - irPlayers.length) }, () => `<tr><td class="slot">IR</td><td class="empty-slot" colspan="${own ? 7 : 5}">Empty</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${own ? `<div class="toolbar"><span class="muted" style="font-size:12.5px">Lineup changes save automatically. Moving a player into a full spot sends the player there to the bench.</span><a class="btn" href="#players">Find players</a></div>` : ''}`}
    ${t.eliminated_week ? '' : '<h2>Player news <span class="muted" style="font-size:13px;font-weight:500">Past 7 days, via RotoWire on ESPN</span></h2><div class="panel" id="team-news"><p class="muted">Loading news</p></div>'}
    ${d.history.length ? `<h2>Weekly results</h2><div class="panel"><ul class="list">${d.history.map((h) => `
      <li><span>Week ${lw(h.week)}${h.eliminated ? ' <span class="badge cut">Cut</span>' : ''}</span><span class="num">${pts(h.points)} <span class="muted">rank ${h.rank}</span></span></li>`).join('')}</ul></div>` : ''}
    ${d.is_owner ? '' : (state.me ? '' : `<p class="muted" style="margin-top:24px">Managing this team? Open the private link the commissioner sent you.</p>`)}`;

  bindPlayerLinks();
  const newsBox = document.getElementById('team-news');
  if (newsBox) {
    api(`/api/teams/${id}/news`).then((n) => {
      newsBox.innerHTML = n.items.length
        ? `<ul class="list news-list">${n.items.map((x) => newsItem(x, true)).join('')}</ul>${n.missing ? `<p class="pmeta">Still gathering news for ${n.missing} player${n.missing > 1 ? 's' : ''}. Check back in a few minutes.</p>` : ''}`
        : `<p class="muted">${n.missing ? 'Gathering news for your players. Check back in a few minutes.' : 'No news for these players in the past week.'}</p>`;
      newsBox.querySelectorAll('[data-player]').forEach((b) => b.addEventListener('click', () => showPlayer(b.dataset.player)));
    }).catch(() => { newsBox.innerHTML = '<p class="muted">News is unavailable right now.</p>'; });
  }
  document.getElementById('logo-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    state.dirty = true;
    const ok = await act(async () => {
      const data = await imageToLogo(file);
      await api('/api/me/logo', { method: 'PUT', body: { data } });
    }, 'Logo saved');
    state.dirty = false;
    if (ok) { renderTeam(id); heartbeat(); }
  });
  document.getElementById('logo-remove')?.addEventListener('click', async () => {
    if (!confirm('Remove your team logo?')) return;
    if (await act(() => api('/api/me/logo', { method: 'DELETE' }), 'Logo removed')) { renderTeam(id); heartbeat(); }
  });
  if (!own) return;
  // Moving a player into a full spot sends the player there to the bench. When the spot has room for
  // more than one (like WR/TE), the owner picks who goes to the bench. Each change saves right away.
  const all = [...d.starters, ...d.bench];
  const byPid = Object.fromEntries(all.map((p) => [p.id, p]));
  const current = Object.fromEntries(all.map((p) => [p.id, Number(d.slots[p.slot]) > 0 ? p.slot : 'BN']));
  const pickOut = (to, choices) => new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'swap-dialog';
    dlg.innerHTML = `<h3>Every ${esc(to)} spot is full</h3><p class="muted">Who should go to the bench?</p>
      <div class="swap-choices">${choices.map((p) => `<button class="btn" data-pick="${esc(p.id)}">${esc(p.name)} <span class="pmeta">${esc(p.pos)} ${esc(p.nfl || '')}, proj ${pts(p.proj)}</span></button>`).join('')}</div>
      <div class="toolbar"><button class="btn sm" data-pick="">Cancel</button></div>`;
    document.body.appendChild(dlg);
    dlg.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { dlg.close(); resolve(b.dataset.pick || null); }));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(null); });
    dlg.showModal();
  });
  $app.querySelectorAll('select[data-slot]').forEach((sel) => sel.addEventListener('change', async () => {
    const mover = byPid[sel.dataset.slot];
    const from = current[mover.id];
    const to = sel.value;
    const moves = { [mover.id]: to };
    let note = '';
    if (to !== 'BN') {
      const occupants = all.filter((p) => p.id !== mover.id && current[p.id] === to);
      if (occupants.length >= Number(d.slots[to])) {
        const open = occupants.filter((p) => !p.locked);
        if (!open.length) { toast(`Every ${to} spot is held by a player whose game has started.`, 'error'); sel.value = from; return; }
        state.dirty = true;
        const outId = open.length === 1 ? open[0].id : await pickOut(to, open);
        if (!outId) { state.dirty = false; sel.value = from; return; }
        moves[outId] = 'BN';
        note = `${byPid[outId].name} moved to the bench`;
      }
    }
    const slots = { ...current, ...moves };
    state.dirty = true;
    $app.querySelectorAll('select[data-slot]').forEach((x) => { x.disabled = true; });
    const ok = await act(() => api('/api/me/lineup', { method: 'POST', body: { slots } }), note ? `Saved. ${note}.` : 'Lineup saved');
    state.dirty = false;
    renderTeam(id);
    if (!ok) sel.value = from;
  }));
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
  state.firstWeek = d.first_week || 1;
  const myRoster = mine ? [...mine.starters, ...mine.bench] : [];
  const dropOptions = `<option value="">No drop</option>${myRoster.map((p) => `<option value="${esc(p.id)}" ${p.locked ? 'disabled' : ''}>${esc(p.name)} (${esc(p.pos)})${p.locked ? ' locked' : ''}</option>`).join('')}`;
  const canAct = !!mine;

  // Bid counts never reveal who bid or how much; for an owner they count other teams only.
  const bidCount = (p) => {
    if (!p.other_bids) return '';
    const n = p.other_bids;
    return `<div class="bid-count">${n} ${canAct ? 'other ' : ''}bid${n > 1 ? 's' : ''}</div>`;
  };
  const statusOf = (p) => {
    if (p.fantasy_team) return esc(p.fantasy_team);
    const base = p.on_waivers || !d.instant_free_agents ? 'Waivers' : 'Free agent';
    const mineTxt = p.my_bid ? `<div class="my-bid">Your bid $${p.my_bid.bid}${p.my_bid.drop_name ? `, dropping ${esc(p.my_bid.drop_name)}` : ''}</div>` : '';
    return `${base}${mineTxt}${bidCount(p)}`;
  };
  const actionOf = (p) => {
    if (!canAct || p.fantasy_team) return '';
    const waiver = p.on_waivers || !d.instant_free_agents;
    if (p.my_bid) return `<button class="btn sm" data-open="${esc(p.id)}">Edit bid</button>`;
    return `<button class="btn sm" data-open="${esc(p.id)}" ${!waiver && p.locked ? 'disabled title="Game has started"' : ''}>${waiver ? 'Bid' : 'Add'}</button>`;
  };
  const formRow = (p) => {
    const waiver = p.on_waivers || !d.instant_free_agents || !!p.my_bid;
    const mb = p.my_bid;
    const drops = mb ? dropOptions.replace(`value="${esc(mb.drop_player_id || '')}"`, `value="${esc(mb.drop_player_id || '')}" selected`) : dropOptions;
    return `<tr class="form-row"><td colspan="7"><div class="inline-form">
      ${waiver ? `<label>${mb ? 'Change your bid' : 'Bid'} (you have $${mine.team.faab})<input type="number" min="0" max="${mine.team.faab}" step="1" value="${mb ? mb.bid : 0}" id="bid-amt" style="width:110px"></label>` : ''}
      <label>Drop<select id="bid-drop">${drops}</select></label>
      <button class="btn primary" data-submit="${esc(p.id)}" data-waiver="${waiver ? 1 : 0}" data-name="${esc(p.name)}" data-editing="${mb ? 1 : 0}">${mb ? 'Update bid' : waiver ? 'Place bid' : 'Add player'}</button>
      ${mb ? `<button class="btn danger" data-cancel-bid="${mb.id}" data-name="${esc(p.name)}">Cancel bid</button>` : ''}
      <button class="btn" data-close>Close</button>
    </div></td></tr>`;
  };

  $app.innerHTML = `
    <section class="hero"><h1>Find <em>Players</em></h1>
      <p>${canAct ? 'Players released by cut teams and recent drops are on waivers until Wednesday. Bids are blind and the highest one wins.' : 'Open your team link to add players and place bids.'}</p>
    </section>
    <div class="toolbar center">
      <input type="search" id="q" placeholder="Search by name" value="${esc(f.q)}" aria-label="Search players">
      <div class="seg" role="group" aria-label="Position">${['', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) => `<button data-pos="${p}" aria-pressed="${f.pos === p}">${p || 'All'}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" id="all" ${f.all ? 'checked' : ''}> Include rostered</label>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Player</th><th class="hide-sm">Game</th><th>Status</th><th class="r">Wk ${lw(d.week)}</th><th class="r">Proj</th><th class="r">Season</th><th></th></tr></thead>
      <tbody>${d.players.map((p) => `<tr>
        <td><button class="pname" data-player="${esc(p.id)}">${esc(p.name)}</button>${p.injury ? `<span class="inj">${esc(p.injury)}</span>` : ''}<div class="pmeta">${esc(p.pos)} ${esc(p.nfl || 'FA')}${byeText(d.byes, p.nfl, d.week)}</div><div class="pmeta show-sm">${gameText(p.game)}</div></td>
        <td class="hide-sm">${gameText(p.game)}</td>
        <td>${statusOf(p)}</td>
        <td class="r pts">${pts(p.points)}</td>
        <td class="r muted">${pts(p.proj)}</td>
        <td class="r">${pts(p.season_pts)}</td>
        <td class="r">${actionOf(p)}</td>
      </tr>${state.openRow === p.id ? formRow(p) : ''}`).join('') || '<tr><td colspan="7" class="muted">No players match. Try another name or position.</td></tr>'}</tbody>
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
      ? await act(() => api('/api/me/claims', { method: 'POST', body: { player_id: b.dataset.submit, drop_player_id: drop, bid: Number(document.getElementById('bid-amt').value) } }), b.dataset.editing === '1' ? `Bid on ${b.dataset.name} updated` : `Bid placed on ${b.dataset.name}`)
      : await act(() => api('/api/me/add', { method: 'POST', body: { player_id: b.dataset.submit, drop_player_id: drop } }), `${b.dataset.name} added`);
    if (ok) { state.openRow = null; await loadMe(); renderPlayers(); }
  });
  $app.querySelector('[data-cancel-bid]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (!confirm(`Cancel your bid on ${b.dataset.name}?`)) return;
    if (await act(() => api(`/api/me/claims/${b.dataset.cancelBid}`, { method: 'DELETE' }), 'Bid canceled')) { state.openRow = null; renderPlayers(); }
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
      <p>Week ${lw(d.week)}: <b class="num">${pts(d.points)}</b> points, projected <span class="num">${pts(d.proj)}</span>. Season: <b class="num">${pts(d.season_pts)}</b>${d.preset !== 'custom' ? ` (${esc(d.preset.replace('_', ' '))} scoring)` : ''}.</p>
      ${d.breakdown.length ? `<div class="table-wrap"><table><thead><tr><th>Stat</th><th class="r">Value</th><th class="r">Pts each</th><th class="r">Pts</th></tr></thead><tbody>
        ${d.breakdown.map((b) => `<tr><td>${esc(STAT_LABELS[b.key] || b.key)} <span class="pmeta">${esc(b.key)}</span></td><td class="r">${b.value}</td><td class="r muted">${b.weight ?? ''}</td><td class="r">${b.points != null ? pts(b.points) : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No stats yet this week.</p>'}
      ${p.pos === 'DEF' ? '' : '<h3 style="margin-top:18px">News, past 7 days</h3><div id="pd-news"><p class="muted">Loading news</p></div>'}`;
    if (p.pos !== 'DEF') {
      api(`/api/players/${encodeURIComponent(id)}/news`).then((n) => {
        const box = document.getElementById('pd-news');
        if (box) box.innerHTML = n.items.length ? `<ul class="list news-list">${n.items.map((x) => newsItem(x, false)).join('')}</ul><p class="pmeta">Via RotoWire on ESPN.</p>` : '<p class="muted">No news in the past week.</p>';
      }).catch(() => { const box = document.getElementById('pd-news'); if (box) box.innerHTML = '<p class="muted">News is unavailable right now.</p>'; });
    }
  } catch (e) { body.innerHTML = `<p>${esc(e.message)}</p>`; }
}

// ------------------------------------------------------------ graveyard / activity
async function renderActivity() {
  const [d, w] = await Promise.all([api('/api/activity'), api('/api/waivers/results')]);
  state.firstWeek = w.first_week || 1;
  const runDate = (id) => new Date(id).toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const resultsHtml = w.runs.length ? w.runs.map((run, i) => `
    <details class="panel wr-run" ${i === 0 ? 'open' : ''}>
      <summary><h3 style="display:inline">Waiver results</h3> <span class="muted">${runDate(run.run_id)}, ${run.players.length} player${run.players.length === 1 ? '' : 's'}</span></summary>
      <ul class="list wr-list">${run.players.map((pl) => `<li>
        <div class="wr-player"><b>${esc(pl.player)}</b> <span class="pmeta">${esc(pl.pos || '')} ${esc(pl.nfl || '')}</span>
          <div class="pmeta">${pl.winner ? `Won by <b>${esc(pl.winner.team)}</b> for $${pl.winner.bid}` : 'Not awarded'}</div></div>
        <div class="wr-bids">${pl.bids.map((b) => `<span class="wr-bid ${b.status}" title="${esc(b.reason || '')}">${teamLogo(b.team_id, b.logo_v, b.team, 'sm')}<span>${esc(b.team)}</span><b>$${b.bid}</b></span>`).join('')}</div>
      </li>`).join('')}</ul>
    </details>`).join('') : '';
  const label = { add: 'Added', drop: 'Dropped', waiver: 'Won on waivers', eliminated: 'Cut', import: 'League import', lineup: 'Lineup change:' };
  $app.innerHTML = `<section class="hero"><h1>League <em>Activity</em></h1><p>Adds, drops, waiver wins and cuts. Waiver bids are revealed here after each Wednesday run.</p></section>
    ${resultsHtml}
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
  state.firstWeek = s.first_week || 1;
  const link = (t) => `${location.origin}/#join/${t.token}`;
  $app.innerHTML = `
    <section class="hero"><h1>Commissioner <em>Tools</em></h1>
      <p>Season ${s.season}, league week ${lw(s.current_week)} (NFL week ${s.current_week}). ${d.player_count} NFL players loaded. ${d.pending_claims} pending bids.
      Synced: players ${ago(d.synced.players)}, games ${ago(d.synced.games)}, stats ${ago(d.synced.stats)}.</p></section>

    <div class="panel"><h3>Weekly operations</h3>
      <p class="muted">These run automatically: live stats every 2 minutes, the player list daily, the cut Tuesday from 10:00 UTC once every game is final, waivers Wednesday from 16:00 UTC.</p>
      <div class="toolbar">
        <button class="btn" data-op="sync">Sync live stats now</button>
        <button class="btn" data-op="players">Sync NFL player list</button>
        <button class="btn" data-op="waivers">Process waivers now</button>
        <button class="btn danger" data-op="finalize">Finalize week ${lw(s.current_week)} and cut</button>
        <label class="check"><input type="checkbox" id="force"> Cut even if games aren't final</label>
      </div>
      <div id="op-result"></div>
    </div>

    <div class="panel"><h3>Import owners and rosters</h3>
      <p class="muted">CSV columns: team, owner, email, player, pos, nfl_team, slot, faab, player_id. One row per player. Only team is required; owner and email can sit on any row. Leave slot blank to auto-fill each lineup by projection.</p>
      <textarea id="csv" rows="8" placeholder="team,owner,email,player,pos,nfl_team,slot&#10;Heads Will Roll,Brad,brad@example.com,Josh Allen,QB,BUF,QB"></textarea>
      <div class="toolbar">
        <label class="btn" style="display:inline-flex">Load CSV file<input type="file" id="csv-file" accept=".csv,text/csv" hidden></label>
        <label class="check"><input type="checkbox" id="replace"> Replace all existing teams</label>
        <label class="check"><input type="checkbox" id="sync"> Sync rosters: make the teams in this file match it exactly</label>
        <label class="check" id="sync-release-wrap" hidden>Dropped players go to
          <select id="sync-release"><option value="free_agents">Free agency</option><option value="waivers">Waivers</option></select></label>
        <button class="btn primary" id="do-import">Import</button>
      </div>
      <div id="import-result"></div>
    </div>

    <div class="panel"><h3>Teams and owner links</h3>
      <p class="muted">Send each owner their private link. Anyone with it can manage that team.</p>
      <div class="table-wrap"><table><thead><tr><th>Team</th><th>Owner</th><th class="r">FAAB</th><th class="r">Roster</th><th>Status</th><th>Last seen</th><th></th></tr></thead><tbody>
      ${d.teams.map((t) => `<tr><td><span style="display:inline-flex;align-items:center;gap:8px">${teamLogo(t.id, t.logo_v, t.name, 'sm')}<a href="#team/${t.id}">${esc(t.name)}</a></span></td><td>${esc(t.owner)}<div class="pmeta">${esc(t.email || '')}</div></td>
        <td class="r">$${t.faab}</td><td class="r"><span ${t.roster_size > d.roster_max ? 'style="color:var(--wf-red);font-weight:700" title="Over the active roster limit"' : ''}>${t.roster_size}/${d.roster_max}</span>${t.ir_size ? ` <span class="pmeta">+${t.ir_size} IR</span>` : ''}</td><td>${t.eliminated_week ? `Cut wk ${lw(t.eliminated_week)}` : 'Alive'}</td>
        <td>${isOnline(t.id) ? '<span class="online-chip"><span class="live-dot"></span>Online</span>' : t.last_seen ? `<span class="muted">${ago(t.last_seen)}</span>` : '<span class="muted">Never</span>'}</td>
        <td class="r" style="white-space:nowrap"><button class="btn sm" data-edit="${t.id}">Edit</button> <button class="btn sm" data-copy="${esc(link(t))}">Copy link</button> <button class="btn sm" data-regen="${t.id}">New link</button></td></tr>
        ${state.editTeam === t.id ? `<tr class="edit-row"><td colspan="7">
          <div class="edit-grid">
            <label>Team name<input id="ed-name" value="${esc(t.name)}"></label>
            <label>Owner<input id="ed-owner" value="${esc(t.owner)}"></label>
            <label>Email<input id="ed-email" type="email" value="${esc(t.email || '')}"></label>
            <label>FAAB<input id="ed-faab" type="number" min="0" step="1" value="${t.faab}"></label>
          </div>
          <div class="toolbar">
            <button class="btn primary sm" data-save-team="${t.id}">Save team</button>
            <button class="btn sm" data-cancel-edit>Cancel</button>
            ${t.logo_v ? `<button class="btn sm danger" data-rm-logo="${t.id}">Remove team logo</button>` : ''}
          </div>
          ${t.eliminated_week ? '' : '<div class="adm-roster" id="adm-roster"><p class="muted">Loading roster</p></div>'}
          ${t.eliminated_week ? '' : `<div class="cut-box">
            <h3>Cut this team</h3>
            <p class="muted">Moves the team to the Graveyard and releases its players to waivers, where owners can bid FAAB on them until waivers run. This can't be undone.</p>
            <div class="edit-grid">
              <label>League week cut<input id="cut-week" type="number" min="1" max="18" step="1" value="${Math.max(1, lw(s.current_week) - 1)}"></label>
              <label>Final score (optional)<input id="cut-points" type="number" step="0.01" placeholder="e.g. 84.36"></label>
            </div>
            <div class="toolbar"><button class="btn danger sm" data-cut="${t.id}" data-name="${esc(t.name)}">Cut team</button></div>
          </div>`}
        </td></tr>` : ''}`).join('') || '<tr><td colspan="7" class="muted">No teams yet. Import a CSV above.</td></tr>'}
      </tbody></table></div>
    </div>

    <div class="panel"><h3>League settings</h3>
      <p class="muted">Scoring weights use Sleeper stat keys. Set scoring.preset to ppr, half_ppr or std to use standard scoring instead of the weights. Click any player's name to see which stat keys he has. Set first_week to the NFL week your league counted as Week 1. Saving re-pulls this week's stats.</p>
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
    if (op === 'finalize' && !confirm(`Finalize week ${lw(s.current_week)}? The lowest score gets cut and their players go to waivers.`)) return;
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
    } catch (e) { out.innerHTML = `<p style="color:var(--wf-red)">${esc(e.message)}</p>`; b.disabled = false; }
  }));

  document.getElementById('csv-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) document.getElementById('csv').value = await f.text();
  });
  const syncBox = document.getElementById('sync');
  syncBox.addEventListener('change', () => {
    document.getElementById('sync-release-wrap').hidden = !syncBox.checked;
    document.getElementById('do-import').textContent = syncBox.checked ? 'Preview changes' : 'Import';
    if (syncBox.checked) document.getElementById('replace').checked = false;
  });
  const runSync = async (csv, preview) => {
    const res = document.getElementById('import-result');
    const release = document.getElementById('sync-release').value;
    res.innerHTML = `<p class="muted">${preview ? 'Comparing rosters' : 'Applying changes'}</p>`;
    try {
      const r = await api('/api/admin/import', { method: 'POST', admin: true, body: { csv, sync: true, preview, release } });
      const total = r.changes.reduce((n, c) => n + c.adds.length + c.removes.length, 0);
      const blocked = r.unmatched.length || r.problems.some((p) => !p.endsWith('was skipped.'));
      const pl = (p) => `${esc(p.name)} <span class="pmeta">${esc(p.pos || '')} ${esc(p.nfl || '')}</span>`;
      const body = `
        ${r.problems.length ? `<ul style="color:var(--wf-red)">${r.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${r.unmatched.length ? `<p style="color:var(--wf-red)">These players didn't match. Add a player_id or nfl_team and try again:</p>
          <ul>${r.unmatched.map((u) => `<li>${esc(u.team)}: ${esc(u.player)} ${esc(u.pos)} ${esc(u.nfl)}</li>`).join('')}</ul>` : ''}
        ${r.changes.map((c) => `<div class="sync-team"><h3>${esc(c.team)} <span class="muted" style="font-weight:500">${c.size} players after</span></h3>
          ${!c.adds.length && !c.removes.length ? '<p class="muted">No changes.</p>' : `<ul class="list">
            ${c.adds.map((a) => `<li><span><b style="color:var(--wf-green-dark)">Add</b> ${pl(a)}${a.from ? ` <span class="muted">from ${esc(a.from)}</span>` : ''}</span></li>`).join('')}
            ${c.removes.map((x) => `<li><span><b style="color:var(--wf-red)">Drop</b> ${pl(x)}</span></li>`).join('')}
          </ul>`}</div>`).join('')}`;
      if (!preview) {
        await renderAdmin();
        document.getElementById('import-result').innerHTML = `<p><b>Done.</b> ${total} roster change${total === 1 ? '' : 's'} applied.</p>${body}`;
        return;
      }
      res.innerHTML = `<p>${total} change${total === 1 ? '' : 's'} across ${r.changes.length} team${r.changes.length === 1 ? '' : 's'}. Nothing has changed yet.</p>${body}
        ${total && !blocked ? '<div class="toolbar"><button class="btn primary" id="apply-sync">Apply these changes</button></div>' : ''}`;
      document.getElementById('apply-sync')?.addEventListener('click', () => {
        if (confirm(`Apply ${total} roster changes?`)) runSync(csv, false);
      });
    } catch (e) { res.innerHTML = `<p style="color:var(--wf-red)">${esc(e.message)}</p>`; }
  };

  document.getElementById('do-import').addEventListener('click', async () => {
    const csv = document.getElementById('csv').value.trim();
    if (!csv) return toast('Paste CSV rows or load a file first.', 'error');
    if (syncBox.checked) return runSync(csv, true);
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
        ${r.unmatched.length ? `<p style="color:var(--wf-red)">${r.unmatched.length} players didn't match. Add a player_id (Sleeper ID) or nfl_team to these rows and import again:</p>
          <ul>${r.unmatched.map((u) => `<li>${esc(u.team)}: ${esc(u.player)} ${esc(u.pos)} ${esc(u.nfl)} ${u.note ? `(${esc(u.note)})` : ''}</li>`).join('')}</ul>` : ''}`;
    } catch (e) { res.innerHTML = `<p style="color:var(--wf-red)">${esc(e.message)}</p>`; }
  });

  $app.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    state.editTeam = Number(b.dataset.edit);
    renderAdmin().then(() => document.getElementById('ed-name')?.focus());
  }));
  $app.querySelector('[data-cancel-edit]')?.addEventListener('click', () => { state.editTeam = null; renderAdmin(); });
  $app.querySelector('[data-save-team]')?.addEventListener('click', async (e) => {
    const body = {
      name: document.getElementById('ed-name').value,
      owner: document.getElementById('ed-owner').value,
      email: document.getElementById('ed-email').value.trim(),
      faab: Number(document.getElementById('ed-faab').value),
    };
    if (await act(() => api(`/api/admin/teams/${e.currentTarget.dataset.saveTeam}`, { method: 'PUT', admin: true, body }), 'Team saved')) {
      state.editTeam = null;
      renderAdmin();
    }
  });
  $app.querySelector('[data-rm-logo]')?.addEventListener('click', async (e) => {
    if (!confirm('Remove this team\'s logo?')) return;
    if (await act(() => api(`/api/admin/teams/${e.currentTarget.dataset.rmLogo}/logo`, { method: 'DELETE', admin: true }), 'Logo removed')) renderAdmin();
  });
  if (state.editTeam && document.getElementById('adm-roster')) loadAdminRoster(state.editTeam).catch((err) => toast(err.message, 'error'));
  $app.querySelector('[data-cut]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    const leagueWeek = Number(document.getElementById('cut-week').value);
    if (!Number.isInteger(leagueWeek) || leagueWeek < 1) return toast('Enter the league week the team was cut.', 'error');
    if (!confirm(`Cut ${b.dataset.name} in week ${leagueWeek} and release their players to waivers? This can't be undone.`)) return;
    const body = { week: leagueWeek + (s.first_week || 1) - 1, points: document.getElementById('cut-points').value };
    if (await act(() => api(`/api/admin/teams/${b.dataset.cut}/cut`, { method: 'POST', admin: true, body }), `${b.dataset.name} moved to the Graveyard`)) {
      state.editTeam = null;
      renderAdmin();
    }
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
    let r;
    if (await act(async () => { r = await api('/api/admin/settings', { method: 'PUT', admin: true, body: { settings: parsed } }); }, 'Settings saved')) {
      await renderAdmin();
      if (r.benched?.length) {
        const out = document.getElementById('op-result');
        const toBench = r.benched.filter((b) => b.to === 'BN');
        out.innerHTML = `<p><b>${r.benched.length} player${r.benched.length === 1 ? '' : 's'} moved</b> because their lineup slot was removed or has fewer spots now.
          ${toBench.length ? `${toBench.length} went to the bench, so let those owners know to reset their lineups.` : 'All of them fit into another starting slot.'}</p>
          <ul>${r.benched.map((b) => `<li>${esc(b.team)}: ${esc(b.player)}, ${esc(b.from)} to ${b.to === 'BN' ? '<b>bench</b>' : esc(b.to)}</li>`).join('')}</ul>`;
        out.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  });
  document.getElementById('do-reset').addEventListener('click', async () => {
    const confirmText = document.getElementById('reset-confirm').value;
    if (await act(() => api('/api/admin/reset', { method: 'POST', admin: true, body: { confirm: confirmText } }), 'League reset')) renderAdmin();
  });
  document.getElementById('sign-out').addEventListener('click', () => { state.adminKey = ''; localStorage.removeItem('gl_admin'); renderAdmin(); });
}

// Commissioner roster tools inside a team's Edit panel.
async function loadAdminRoster(teamId) {
  const box = document.getElementById('adm-roster');
  if (!box) return;
  const d = await api(`/api/teams/${teamId}`);
  const players = [...d.starters, ...d.bench];
  const slotNames = Object.keys(d.slots).filter((k) => k === 'BN' || Number(d.slots[k]) > 0);
  box.innerHTML = `
    <h3>Roster <span class="muted" style="font-weight:500">${players.filter((p) => p.slot !== 'IR').length}/${d.roster_max} active${d.ir_max ? `, ${players.filter((p) => p.slot === 'IR').length}/${d.ir_max} IR` : ''}</span></h3>
    <div class="adm-roster-grid">
      <div>
        <label class="check" style="margin-bottom:6px">Removed players go to
          <select id="rm-to"><option value="waivers">Waivers</option><option value="free_agents">Free agency</option></select></label>
        <ul class="list adm-list">${players.map((p) => `<li>
          <span><b>${esc(p.name)}</b>${p.injury ? `<span class="inj">${esc(p.injury)}</span>` : ''} <span class="pmeta">${esc(p.pos)} ${esc(p.nfl || 'FA')}</span></span>
          <span style="display:flex;gap:6px;align-items:center">
            <select data-adm-slot="${esc(p.id)}" data-name="${esc(p.name)}" aria-label="Slot for ${esc(p.name)}">${slotNames.map((k) => `<option ${k === p.slot ? 'selected' : ''}>${k}</option>`).join('')}</select>
            <button class="btn sm danger" data-rm="${esc(p.id)}" data-name="${esc(p.name)}">Remove</button>
          </span></li>`).join('') || '<li class="muted">No players on this roster.</li>'}</ul>
        <p class="pmeta" style="margin-top:6px">Changing a slot here is a commissioner override. It skips game locks, position rules and IR eligibility.</p>
      </div>
      <div>
        <label>Add a player<input type="search" id="adm-q" placeholder="Search any NFL player" autocomplete="off"></label>
        <ul class="list adm-results" id="adm-results"></ul>
      </div>
    </div>`;

  box.querySelectorAll('[data-adm-slot]').forEach((sel) => sel.addEventListener('change', async () => {
    const ok = await act(() => api(`/api/admin/teams/${teamId}/slot`, { method: 'POST', admin: true, body: { player_id: sel.dataset.admSlot, slot: sel.value } }), `${sel.dataset.name} moved to ${sel.value}`);
    loadAdminRoster(teamId).catch(() => {});
    if (!ok) return;
  }));
  box.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
    const to = document.getElementById('rm-to').value;
    if (!confirm(`Remove ${b.dataset.name} from ${d.team.name}? He goes to ${to === 'waivers' ? 'waivers' : 'free agency'}.`)) return;
    if (await act(() => api(`/api/admin/teams/${teamId}/players/${encodeURIComponent(b.dataset.rm)}?to=${to}`, { method: 'DELETE', admin: true }), `${b.dataset.name} removed`)) renderAdmin();
  }));

  let deb;
  const q = document.getElementById('adm-q');
  const results = document.getElementById('adm-results');
  q.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(async () => {
      const term = q.value.trim();
      if (term.length < 2) { results.innerHTML = ''; return; }
      const r = await api(`/api/players?q=${encodeURIComponent(term)}&all=1`);
      results.innerHTML = r.players.slice(0, 8).map((p) => {
        const here = p.team_id === teamId;
        const status = p.fantasy_team ? `On ${esc(p.fantasy_team)}` : p.on_waivers ? 'Waivers' : 'Free agent';
        return `<li><span><b>${esc(p.name)}</b> <span class="pmeta">${esc(p.pos)} ${esc(p.nfl || 'FA')}, ${status}</span></span>
          ${here ? '<span class="muted" style="font-size:12px">On this team</span>'
            : `<button class="btn sm ${p.fantasy_team ? '' : 'primary'}" data-add="${esc(p.id)}" data-name="${esc(p.name)}" data-from="${esc(p.fantasy_team || '')}">${p.fantasy_team ? 'Move here' : 'Add'}</button>`}</li>`;
      }).join('') || '<li class="muted">No players match.</li>';
      results.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', async () => {
        const from = b.dataset.from;
        if (from && !confirm(`Move ${b.dataset.name} from ${from} to ${d.team.name}?`)) return;
        if (await act(() => api(`/api/admin/teams/${teamId}/players`, { method: 'POST', admin: true, body: { player_id: b.dataset.add, move: !!from } }), `${b.dataset.name} added to ${d.team.name}`)) renderAdmin();
      }));
    }, 300);
  });
}

function adminLogin(msg = '') {
  $app.innerHTML = `<section class="hero"><h1>Commissioner <em>Tools</em></h1></section>
    <div class="panel"><form id="admin-login" class="inline-form">
      <label>Commissioner key<input type="password" id="admin-key" autocomplete="current-password" required></label>
      <button class="btn primary">Sign in</button></form>
      ${msg ? `<p style="color:var(--wf-red)">${esc(msg)}</p>` : ''}</div>`;
  document.getElementById('admin-login').addEventListener('submit', (e) => {
    e.preventDefault();
    state.adminKey = document.getElementById('admin-key').value;
    localStorage.setItem('gl_admin', state.adminKey);
    renderAdmin().catch((err) => toast(err.message, 'error'));
  });
}

// ------------------------------------------------------------ boot
window.addEventListener('hashchange', () => { state.openRow = null; router().then(heartbeat); });
loadMe().finally(() => router().then(heartbeat));
