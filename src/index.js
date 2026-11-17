// Guillotine League: Cloudflare Worker + D1
// Live stats: Sleeper (player stats/projections) + ESPN (game clock/scores). Both are free, keyless, unofficial endpoints.

const SLEEPER = 'https://api.sleeper.app/v1';
const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const FANTASY_POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const TEAM_ALIASES = { WSH: 'WAS', JAC: 'JAX', LA: 'LAR' };
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; GuillotineLeague/1.0)' };

// Always kept in the stored stat blobs (in addition to every key in the scoring weights).
const KEEP_KEYS = [
  'pts_ppr', 'pts_half_ppr', 'pts_std', 'gp',
  'pass_att', 'pass_cmp', 'pass_yd', 'pass_td', 'pass_int',
  'rush_att', 'rush_yd', 'rush_td', 'rec_tgt', 'rec', 'rec_yd', 'rec_td', 'fum_lost',
  'fgm', 'fga', 'xpm', 'xpa', 'sack', 'int', 'fum_rec', 'def_td', 'pts_allow',
];

// Half-PPR defaults using Sleeper stat keys. Edit in Admin > League settings.
const DEFAULT_WEIGHTS = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2,
  rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
  rec: 0.5, rec_yd: 0.1, rec_td: 6, rec_2pt: 2,
  fum_lost: -2, st_td: 6,
  fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50p: 5, xpm: 1, fgmiss: -1, xpmiss: -1,
  sack: 1, int: 2, fum_rec: 2, def_td: 6, def_st_td: 6, safe: 2, blk_kick: 2,
  pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1,
  pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4,
};

const DEFAULT_SETTINGS = {
  league_name: 'Guillotine League',
  season: null,
  current_week: null,
  faab_budget: 1000,
  cuts_per_week: 1,
  cuts_overrides: {},              // e.g. { "1": 2 } to cut two teams in week 1
  roster_slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1, BN: 6 },
  flex_eligibility: { FLEX: ['RB', 'WR', 'TE'], SUPERFLEX: ['QB', 'RB', 'WR', 'TE'] },
  instant_free_agents: true,       // unrostered players not on waivers can be added immediately
  auto_waivers: true,              // process FAAB claims on the Wednesday cron
  auto_finalize: true,             // run the weekly cut on the Tuesday cron once every game is final
  scoring: { preset: 'custom', weights: DEFAULT_WEIGHTS }, // preset: custom | ppr | half_ppr | std
  champion_team_id: null,
  last_waiver_run: null,
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const normTeam = (abbr) => (abbr ? TEAM_ALIASES[abbr] || abbr : null);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      await ensureSchema(env);
      return await route(request, env, ctx, url);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      return json({ error: err.message || 'Server error' }, status);
    }
  },

  // One cron trigger ("*/2 * * * *"). Weekly and daily jobs are scheduled inside, so the
  // Worker fits the free plan's limits (5 cron triggers per account, 10 ms CPU per run).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env).catch((e) => console.error('tick failed', e)));
  },
};

// ---------------------------------------------------------------- schema + scheduler

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  "CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, owner TEXT NOT NULL DEFAULT '', email TEXT, token TEXT NOT NULL UNIQUE, faab INTEGER NOT NULL DEFAULT 1000, eliminated_week INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, name TEXT NOT NULL, pos TEXT NOT NULL, team TEXT, status TEXT, injury TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
  'CREATE INDEX IF NOT EXISTS idx_players_pos ON players(pos)',
  "CREATE TABLE IF NOT EXISTS rosters (player_id TEXT PRIMARY KEY, team_id INTEGER NOT NULL, slot TEXT NOT NULL DEFAULT 'BN', acquired_at TEXT NOT NULL DEFAULT (datetime('now')))",
  'CREATE INDEX IF NOT EXISTS idx_rosters_team ON rosters(team_id)',
  "CREATE TABLE IF NOT EXISTS waiver_wire (player_id TEXT PRIMARY KEY, since TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS claims (id INTEGER PRIMARY KEY AUTOINCREMENT, team_id INTEGER NOT NULL, player_id TEXT NOT NULL, drop_player_id TEXT, bid INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), processed_at TEXT)",
  'CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status)',
  'CREATE TABLE IF NOT EXISTS games (season INTEGER NOT NULL, week INTEGER NOT NULL, game_id TEXT NOT NULL, home TEXT, away TEXT, kickoff TEXT, state TEXT, period INTEGER, clock TEXT, detail TEXT, home_score INTEGER, away_score INTEGER, PRIMARY KEY (season, week, game_id))',
  'CREATE TABLE IF NOT EXISTS stat_blobs (season INTEGER NOT NULL, week INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (season, week, kind))',
  'CREATE TABLE IF NOT EXISTS team_weeks (season INTEGER NOT NULL, week INTEGER NOT NULL, team_id INTEGER NOT NULL, points REAL NOT NULL, bench REAL NOT NULL DEFAULT 0, rank INTEGER, eliminated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (season, week, team_id))',
  'CREATE TABLE IF NOT EXISTS weekly_lineups (season INTEGER NOT NULL, week INTEGER NOT NULL, team_id INTEGER NOT NULL, player_id TEXT NOT NULL, slot TEXT NOT NULL, points REAL, PRIMARY KEY (season, week, team_id, player_id))',
  "CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), week INTEGER, type TEXT NOT NULL, team_id INTEGER, player_id TEXT, detail TEXT)",
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transactions'").first();
  if (!t) await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
  schemaReady = true;
}

// Runs every 2 minutes. Each run does at most one heavy job so it stays inside the CPU budget.
async function tick(env) {
  await ensureSchema(env);
  const live = await syncLive(env);
  if (live.heavy) return;

  const s = await getSettings(env);
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const today = now.toISOString().slice(0, 10);

  // Tuesday 10:00 UTC onward: make the cut once every game of the week is final.
  if (s.auto_finalize && day === 2 && hour >= 10 && s.season && s.current_week <= 18) {
    const lastTry = Number((await getKV(env, 'finalize_try')) || 0);
    const games = await loadGames(env, s.season, s.current_week);
    if (games.length && games.every((g) => g.state === 'post') && Date.now() - lastTry > 3600e3) {
      await setKV(env, 'finalize_try', Date.now());
      await finalizeWeek(env, { force: false });
      return;
    }
  }

  // Wednesday 16:00 UTC onward: process FAAB claims once.
  if (s.auto_waivers && day === 3 && hour >= 16 && (await getKV(env, 'waivers_ran')) !== today) {
    await setKV(env, 'waivers_ran', today);
    await processWaivers(env);
    return;
  }

  // Refresh one position of the NFL player list per run, each about once a day.
  let oldest = null;
  for (const pos of FANTASY_POS) {
    const at = Number((await getKV(env, `players_at:${pos}`)) || 0);
    if (!oldest || at < oldest.at) oldest = { pos, at };
  }
  if (Date.now() - oldest.at > 20 * 3600e3) await syncPlayerPosition(env, oldest.pos);
}

// ---------------------------------------------------------------- routing

async function route(req, env, ctx, url) {
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;
  const body = async () => {
    try { return await req.json(); } catch { throw new HttpError(400, 'Request body must be JSON.'); }
  };
  let mt;

  // Public
  if (m === 'GET' && p === '/api/live') return json(await apiLive(env, ctx));
  if (m === 'GET' && (mt = p.match(/^\/api\/teams\/(\d+)$/))) return json(await apiTeam(env, Number(mt[1]), req));
  if (m === 'GET' && p === '/api/graveyard') return json(await apiGraveyard(env));
  if (m === 'GET' && p === '/api/players') return json(await apiPlayers(env, url));
  if (m === 'GET' && (mt = p.match(/^\/api\/players\/([^/]+)$/))) return json(await apiPlayer(env, decodeURIComponent(mt[1])));
  if (m === 'GET' && p === '/api/activity') return json(await apiActivity(env));

  // Team owner (secret link token)
  if (p === '/api/me' || p.startsWith('/api/me/')) {
    const team = await requireOwner(env, req);
    if (m === 'GET' && p === '/api/me') return json({ team: { id: team.id, name: team.name, owner: team.owner, faab: team.faab, eliminated_week: team.eliminated_week } });
    if (m === 'POST' && p === '/api/me/lineup') return json(await setLineup(env, team, await body()));
    if (m === 'POST' && p === '/api/me/add') return json(await addFreeAgent(env, team, await body()));
    if (m === 'POST' && p === '/api/me/drop') return json(await dropPlayer(env, team, await body()));
    if (m === 'POST' && p === '/api/me/claims') return json(await createClaim(env, team, await body()));
    if (m === 'DELETE' && (mt = p.match(/^\/api\/me\/claims\/(\d+)$/))) return json(await cancelClaim(env, team, Number(mt[1])));
  }

  // Commissioner
  if (p.startsWith('/api/admin')) {
    requireAdmin(env, req);
    if (m === 'GET' && p === '/api/admin/overview') return json(await adminOverview(env));
    if (m === 'PUT' && p === '/api/admin/settings') return json(await adminSettings(env, await body()));
    if (m === 'POST' && p === '/api/admin/import') return json(await adminImport(env, await body()));
    if (m === 'POST' && p === '/api/admin/sync') {
      const b = await body();
      if (b.what === 'players') return json(await syncPlayerPosition(env, b.pos));
      return json(await syncLive(env, { force: true }));
    }
    if (m === 'POST' && p === '/api/admin/finalize') return json(await finalizeWeek(env, { force: !!(await body()).force }));
    if (m === 'POST' && p === '/api/admin/waivers') return json(await processWaivers(env));
    if (m === 'PUT' && (mt = p.match(/^\/api\/admin\/teams\/(\d+)$/))) return json(await adminUpdateTeam(env, Number(mt[1]), await body()));
    if (m === 'POST' && (mt = p.match(/^\/api\/admin\/teams\/(\d+)\/token$/))) return json(await adminNewToken(env, Number(mt[1])));
    if (m === 'POST' && p === '/api/admin/reset') return json(await adminReset(env, await body()));
  }

  throw new HttpError(404, 'Not found.');
}

function requireAdmin(env, req) {
  if (!env.ADMIN_KEY) throw new HttpError(500, 'ADMIN_KEY secret is not set. Run: npx wrangler secret put ADMIN_KEY');
  if (req.headers.get('x-admin-key') !== env.ADMIN_KEY) throw new HttpError(401, 'Commissioner key is incorrect.');
}

async function requireOwner(env, req) {
  const token = req.headers.get('x-team-token');
  if (!token) throw new HttpError(401, 'Open your team link from the commissioner to manage your team.');
  const team = await env.DB.prepare('SELECT * FROM teams WHERE token = ?').bind(token).first();
  if (!team) throw new HttpError(401, 'Your team link is no longer valid. Ask the commissioner for a new one.');
  return team;
}

function assertAlive(team) {
  if (team.eliminated_week) throw new HttpError(403, `${team.name} was cut in week ${team.eliminated_week}.`);
}

// ---------------------------------------------------------------- settings / kv

async function getKV(env, key) {
  const r = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
  return r ? r.value : null;
}
async function setKV(env, key, value) {
  await env.DB.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value)).run();
}
async function getSettings(env) {
  const raw = await getKV(env, 'league');
  return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
}
async function saveSettings(env, s) { await setKV(env, 'league', JSON.stringify(s)); }

async function ensureSeasonWeek(env, s) {
  if (s.season && s.current_week) return s;
  const res = await fetch(`${SLEEPER}/state/nfl`, { headers: UA });
  if (!res.ok) throw new Error(`Sleeper state returned ${res.status}`);
  const st = await res.json();
  s.season = s.season || Number(st.league_season || st.season);
  s.current_week = s.current_week || Math.min(18, Math.max(1, Number(st.week) || 1));
  await saveSettings(env, s);
  return s;
}

const rosterMax = (s) => Object.values(s.roster_slots).reduce((a, b) => a + Number(b || 0), 0);
const cutsForWeek = (s, week) => Number(s.cuts_overrides?.[week] ?? s.cuts_per_week ?? 1);
const isStarter = (slot) => slot !== 'BN' && slot !== 'IR';

function eligible(pos, slot, s) {
  if (slot === 'BN') return true;
  const flex = s.flex_eligibility?.[slot];
  return flex ? flex.includes(pos) : pos === slot;
}

// ---------------------------------------------------------------- data sync

// Uses Sleeper's per-position season projections, which carry player names and teams.
// About 1 MB at most (WR), versus 14 MB for the full player file, so it fits the free plan.
async function syncPlayerPosition(env, pos) {
  pos = String(pos || '').toUpperCase();
  if (!FANTASY_POS.includes(pos)) throw new HttpError(400, `Unknown position ${pos}.`);
  const s = await ensureSeasonWeek(env, await getSettings(env));
  const res = await fetch(`https://api.sleeper.com/projections/nfl/${s.season}?season_type=regular&position[]=${pos}`, { headers: UA });
  if (!res.ok) throw new Error(`Sleeper ${pos} list returned ${res.status}`);
  const data = await res.json();
  const stmt = env.DB.prepare(`INSERT INTO players (id, name, pos, team, status, injury, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, pos = excluded.pos, team = excluded.team,
      injury = excluded.injury, updated_at = excluded.updated_at`);
  const stmts = [];
  for (const row of Array.isArray(data) ? data : []) {
    const pl = row.player;
    if (!pl || !pl.team || !row.player_id) continue;
    const name = `${pl.first_name || ''} ${pl.last_name || ''}`.trim() || row.player_id;
    stmts.push(stmt.bind(String(row.player_id), name, pos, normTeam(pl.team), pl.injury_status || null));
  }
  if (stmts.length > 10) {
    // Players at this position not in today's list are no longer on an NFL roster.
    stmts.push(env.DB.prepare("UPDATE players SET team = NULL WHERE pos = ? AND updated_at < datetime('now', '-1 hour')").bind(pos));
  }
  for (let i = 0; i < stmts.length; i += 400) await env.DB.batch(stmts.slice(i, i + 400));
  await setKV(env, `players_at:${pos}`, Date.now());
  await setKV(env, 'players_at', Date.now());
  return { ok: true, pos, players: stmts.length };
}

async function syncGames(env, season, week) {
  const res = await fetch(`${ESPN_SCOREBOARD}?seasontype=2&week=${week}&dates=${season}`, { headers: UA });
  if (!res.ok) throw new Error(`ESPN scoreboard returned ${res.status}`);
  const data = await res.json();
  const stmt = env.DB.prepare(`INSERT INTO games (season, week, game_id, home, away, kickoff, state, period, clock, detail, home_score, away_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(season, week, game_id) DO UPDATE SET home = excluded.home, away = excluded.away, kickoff = excluded.kickoff,
      state = excluded.state, period = excluded.period, clock = excluded.clock, detail = excluded.detail,
      home_score = excluded.home_score, away_score = excluded.away_score`);
  const stmts = [];
  for (const ev of data.events || []) {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find((c) => c.homeAway === 'home');
    const away = comp?.competitors?.find((c) => c.homeAway === 'away');
    if (!home || !away) continue;
    const st = comp.status || ev.status || {};
    stmts.push(stmt.bind(
      season, week, String(ev.id),
      normTeam(home.team?.abbreviation), normTeam(away.team?.abbreviation),
      ev.date || comp.date, st.type?.state || 'pre', Number(st.period || 0), st.displayClock || '',
      st.type?.shortDetail || '', Number(home.score || 0), Number(away.score || 0),
    ));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await setKV(env, `games_at:${season}:${week}`, Date.now());
}

function normalizeStatsPayload(data) {
  if (Array.isArray(data)) {
    const out = {};
    for (const it of data) if (it && it.player_id) out[it.player_id] = it.stats || {};
    return out;
  }
  return data || {};
}

async function syncBlob(env, kind, season, week, s) {
  const path = kind === 'stats' ? 'stats' : 'projections';
  const res = await fetch(`${SLEEPER}/${path}/nfl/regular/${season}/${week}`, { headers: UA });
  if (!res.ok) throw new Error(`Sleeper ${path} returned ${res.status}`);
  const raw = normalizeStatsPayload(await res.json());
  const keep = new Set([...KEEP_KEYS, ...Object.keys(s.scoring?.weights || {})]);
  const compact = {};
  for (const [pid, st] of Object.entries(raw)) {
    if (!st) continue;
    const o = {};
    let any = false;
    for (const k in st) if (keep.has(k) && st[k] != null && st[k] !== 0) { o[k] = st[k]; any = true; }
    if (any) compact[pid] = o;
  }
  await env.DB.prepare(`INSERT INTO stat_blobs (season, week, kind, data, fetched_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(season, week, kind) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`)
    .bind(season, week, kind, JSON.stringify(compact), new Date().toISOString()).run();
  await setKV(env, `${kind}_at:${season}:${week}`, Date.now());
}

async function loadBlob(env, kind, season, week) {
  const r = await env.DB.prepare('SELECT data FROM stat_blobs WHERE season = ? AND week = ? AND kind = ?').bind(season, week, kind).first();
  return r ? JSON.parse(r.data) : {};
}

async function loadGames(env, season, week) {
  const r = await env.DB.prepare('SELECT * FROM games WHERE season = ? AND week = ? ORDER BY kickoff').bind(season, week).all();
  return r.results;
}

// Called by the 2-minute cron and lazily by page views. Only hits upstream APIs when it matters.
async function syncLive(env, { force = false } = {}) {
  const now = Date.now();
  if (!force) {
    const lock = Number((await getKV(env, 'sync_lock')) || 0);
    if (now - lock < 45000) return { skipped: true, heavy: false };
  }
  await setKV(env, 'sync_lock', now);

  const s = await ensureSeasonWeek(env, await getSettings(env));
  const { season, current_week: week } = s;
  if (week > 18) return { season, week, done: true, heavy: false };

  let games = await loadGames(env, season, week);
  const gamesAt = Number((await getKV(env, `games_at:${season}:${week}`)) || 0);
  const anyLive = games.some((g) => g.state === 'in');
  const startingSoon = games.some((g) => g.state === 'pre' && Date.parse(g.kickoff) - now < 10 * 60e3);
  if (force || !games.length || anyLive || startingSoon || now - gamesAt > 30 * 60e3) {
    await syncGames(env, season, week);
    games = await loadGames(env, season, week);
  }

  const liveNow = games.some((g) => g.state === 'in');
  const recentFinal = games.some((g) => g.state === 'post' && now - Date.parse(g.kickoff) < 8 * 3600e3);
  const statsAt = Number((await getKV(env, `stats_at:${season}:${week}`)) || 0);
  let heavy = false;
  if (force || liveNow || (recentFinal && now - statsAt > 5 * 60e3) || now - statsAt > 6 * 3600e3) {
    await syncBlob(env, 'stats', season, week, s);
    heavy = true;
  }
  const projAt = Number((await getKV(env, `proj_at:${season}:${week}`)) || 0);
  // Outside of a forced sync, projections refresh on their own run so each run parses one file.
  if (force || (!heavy && now - projAt > 6 * 3600e3)) {
    await syncBlob(env, 'proj', season, week, s);
    heavy = true;
  }

  return { ok: true, season, week, live: liveNow, games: games.length, heavy };
}

// ---------------------------------------------------------------- scoring

function playerPoints(st, scoring) {
  if (!st) return 0;
  if (scoring?.preset && scoring.preset !== 'custom') return round2(st[`pts_${scoring.preset}`]);
  let pts = 0;
  for (const [k, w] of Object.entries(scoring?.weights || {})) {
    const v = Number(st[k]);
    if (v) pts += v * Number(w);
  }
  return round2(pts);
}

function gameIndex(games) {
  const by = {};
  for (const g of games) { if (g.home) by[g.home] = g; if (g.away) by[g.away] = g; }
  return by;
}

function gameProgress(g) {
  if (!g || g.state === 'pre') return 0;
  if (g.state === 'post') return 1;
  const [mm, ss] = String(g.clock || '15:00').split(':').map(Number);
  const left = (mm || 0) + (ss || 0) / 60;
  if (g.period > 4) return 0.98;
  const elapsed = (Math.max(1, g.period) - 1) * 15 + (15 - left);
  return Math.min(0.99, Math.max(0, elapsed / 60));
}

const isLocked = (g, now) => !!g && (g.state !== 'pre' || Date.parse(g.kickoff) <= now);

function gameFor(g, team) {
  if (!g) return null;
  const home = g.home === team;
  return {
    opp: home ? g.away : g.home, home, state: g.state, detail: g.detail, kickoff: g.kickoff,
    team_score: home ? g.home_score : g.away_score, opp_score: home ? g.away_score : g.home_score,
  };
}

function decoratePlayer(r, gameBy, stats, proj, s, now) {
  const g = r.nfl ? gameBy[r.nfl] : null;
  const points = playerPoints(stats[r.player_id], s.scoring);
  const projPts = playerPoints(proj[r.player_id], s.scoring);
  const state = g ? g.state : 'bye';
  const progress = gameProgress(g);
  const projected = state === 'pre' ? projPts : state === 'in' ? points + projPts * (1 - progress) : points;
  return {
    id: r.player_id, name: r.name || r.player_id, pos: r.pos, nfl: r.nfl, injury: r.injury || null,
    slot: r.slot, points, proj: projPts, projected: round2(projected), state,
    locked: isLocked(g, now), game: gameFor(g, r.nfl),
  };
}

async function buildWeek(env, s) {
  const { season, current_week: week } = s;
  const now = Date.now();
  const [teamsR, rosterR, games, stats, proj, totalsR] = await Promise.all([
    env.DB.prepare('SELECT id, name, owner, faab, eliminated_week FROM teams ORDER BY id').all(),
    env.DB.prepare(`SELECT r.player_id, r.team_id, r.slot, p.name, p.pos, p.team AS nfl, p.injury
      FROM rosters r LEFT JOIN players p ON p.id = r.player_id`).all(),
    loadGames(env, season, week),
    loadBlob(env, 'stats', season, week),
    loadBlob(env, 'proj', season, week),
    env.DB.prepare('SELECT team_id, SUM(points) AS total FROM team_weeks WHERE season = ? GROUP BY team_id').bind(season).all(),
  ]);
  const gameBy = gameIndex(games);
  const totals = Object.fromEntries(totalsR.results.map((r) => [r.team_id, r.total || 0]));
  const order = Object.keys(s.roster_slots);
  const teams = teamsR.results.map((t) => ({
    ...t, points: 0, projected: 0, bench_points: 0, season_total: round2(totals[t.id]), starters: [], bench: [],
  }));
  const byId = Object.fromEntries(teams.map((t) => [t.id, t]));
  for (const r of rosterR.results) {
    const t = byId[r.team_id];
    if (!t) continue;
    const pl = decoratePlayer(r, gameBy, stats, proj, s, now);
    if (isStarter(r.slot)) { t.starters.push(pl); t.points += pl.points; t.projected += pl.projected; }
    else { t.bench.push(pl); t.bench_points += pl.points; }
  }
  for (const t of teams) {
    t.points = round2(t.points); t.projected = round2(t.projected); t.bench_points = round2(t.bench_points);
    t.starters.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
    t.bench.sort((a, b) => FANTASY_POS.indexOf(a.pos) - FANTASY_POS.indexOf(b.pos) || b.proj - a.proj);
  }
  return { season, week, games, teams, gameBy, stats, proj };
}

const byProjection = (a, b) => b.projected - a.projected || b.points - a.points;

// ---------------------------------------------------------------- public API

async function apiLive(env, ctx) {
  let s = await getSettings(env);
  const gamesAt = s.season ? Number((await getKV(env, `games_at:${s.season}:${s.current_week}`)) || 0) : 0;
  if (!gamesAt) {
    await syncLive(env, { force: true });
    s = await getSettings(env);
  }
  const wk = await buildWeek(env, s);
  const alive = wk.teams.filter((t) => !t.eliminated_week).sort(byProjection);
  const cuts = Math.min(cutsForWeek(s, wk.week), Math.max(alive.length - 1, 0));
  const champion = s.champion_team_id ? wk.teams.find((t) => t.id === s.champion_team_id) : null;
  return {
    league: s.league_name, season: wk.season, week: wk.week, cuts,
    champion: champion ? { id: champion.id, name: champion.name, owner: champion.owner } : null,
    eliminated_count: wk.teams.length - alive.length,
    stats_updated: Number((await getKV(env, `stats_at:${wk.season}:${wk.week}`)) || 0),
    alive: alive.map((t) => ({
      id: t.id, name: t.name, owner: t.owner, points: t.points, projected: t.projected,
      season_total: t.season_total, faab: t.faab,
      pips: t.starters.map((p) => p.state),
    })),
    games: wk.games.map((g) => ({
      id: g.game_id, home: g.home, away: g.away, state: g.state, detail: g.detail,
      kickoff: g.kickoff, home_score: g.home_score, away_score: g.away_score,
    })),
  };
}

async function apiTeam(env, id, req) {
  const s = await getSettings(env);
  const wk = await buildWeek(env, s);
  const t = wk.teams.find((x) => x.id === id);
  if (!t) throw new HttpError(404, 'Team not found.');
  const token = req.headers.get('x-team-token');
  const row = await env.DB.prepare('SELECT token FROM teams WHERE id = ?').bind(id).first();
  const is_owner = !!token && row?.token === token;
  const history = (await env.DB.prepare(
    'SELECT week, points, bench, rank, eliminated FROM team_weeks WHERE season = ? AND team_id = ? ORDER BY week DESC',
  ).bind(wk.season, id).all()).results;
  let claims = [];
  if (is_owner) {
    claims = (await env.DB.prepare(`SELECT c.id, c.bid, c.status, c.reason, c.created_at, c.player_id,
        p.name AS player, p.pos, p.team AS nfl, d.name AS drop_name
      FROM claims c LEFT JOIN players p ON p.id = c.player_id LEFT JOIN players d ON d.id = c.drop_player_id
      WHERE c.team_id = ? ORDER BY c.id DESC LIMIT 30`).bind(id).all()).results;
  }
  return {
    season: wk.season, week: wk.week, is_owner,
    team: {
      id: t.id, name: t.name, owner: t.owner, faab: t.faab, eliminated_week: t.eliminated_week,
      points: t.points, projected: t.projected, bench_points: t.bench_points, season_total: t.season_total,
    },
    starters: t.starters, bench: t.bench,
    slots: s.roster_slots, flex: s.flex_eligibility, roster_max: rosterMax(s),
    history, claims,
  };
}

async function apiGraveyard(env) {
  const s = await getSettings(env);
  const r = await env.DB.prepare(`SELECT t.id, t.name, t.owner, t.eliminated_week, tw.points
    FROM teams t LEFT JOIN team_weeks tw ON tw.team_id = t.id AND tw.week = t.eliminated_week AND tw.season = ?
    WHERE t.eliminated_week IS NOT NULL ORDER BY t.eliminated_week DESC, tw.points ASC`).bind(s.season).all();
  return { teams: r.results };
}

async function apiPlayers(env, url) {
  const s = await getSettings(env);
  const pos = (url.searchParams.get('pos') || '').toUpperCase();
  const q = (url.searchParams.get('q') || '').trim();
  const all = url.searchParams.get('all') === '1';
  const rows = (await env.DB.prepare(`SELECT p.id, p.name, p.pos, p.team AS nfl, p.injury, r.team_id, t.name AS fantasy_team,
      CASE WHEN w.player_id IS NULL THEN 0 ELSE 1 END AS on_waivers
    FROM players p
    LEFT JOIN rosters r ON r.player_id = p.id
    LEFT JOIN teams t ON t.id = r.team_id
    LEFT JOIN waiver_wire w ON w.player_id = p.id
    WHERE (?1 = '' OR p.pos = ?1) AND (?2 = '' OR p.name LIKE ?2) AND (?3 = 1 OR r.player_id IS NULL)`)
    .bind(pos, q ? `%${q}%` : '', all ? 1 : 0).all()).results;
  const [games, stats, proj] = await Promise.all([
    loadGames(env, s.season, s.current_week),
    loadBlob(env, 'stats', s.season, s.current_week),
    loadBlob(env, 'proj', s.season, s.current_week),
  ]);
  const gameBy = gameIndex(games);
  const now = Date.now();
  const players = rows.map((r) => {
    const g = r.nfl ? gameBy[r.nfl] : null;
    return {
      id: r.id, name: r.name, pos: r.pos, nfl: r.nfl, injury: r.injury,
      team_id: r.team_id, fantasy_team: r.fantasy_team, on_waivers: !!r.on_waivers,
      points: playerPoints(stats[r.id], s.scoring), proj: playerPoints(proj[r.id], s.scoring),
      locked: isLocked(g, now), game: gameFor(g, r.nfl), state: g ? g.state : 'bye',
    };
  }).sort((a, b) => b.proj - a.proj || b.points - a.points).slice(0, 150);
  return { week: s.current_week, instant_free_agents: s.instant_free_agents, players };
}

async function apiPlayer(env, id) {
  const s = await getSettings(env);
  const p = await env.DB.prepare(`SELECT p.*, t.name AS fantasy_team FROM players p
    LEFT JOIN rosters r ON r.player_id = p.id LEFT JOIN teams t ON t.id = r.team_id WHERE p.id = ?`).bind(id).first();
  if (!p) throw new HttpError(404, 'Player not found.');
  const [stats, proj] = await Promise.all([
    loadBlob(env, 'stats', s.season, s.current_week),
    loadBlob(env, 'proj', s.season, s.current_week),
  ]);
  const st = stats[id] || {};
  const weights = s.scoring?.weights || {};
  const breakdown = Object.entries(st)
    .filter(([k]) => !['pts_ppr', 'pts_half_ppr', 'pts_std'].includes(k))
    .map(([key, value]) => ({ key, value, weight: weights[key] ?? null, points: weights[key] != null ? round2(value * weights[key]) : null }))
    .sort((a, b) => Math.abs(b.points || 0) - Math.abs(a.points || 0));
  return {
    week: s.current_week, preset: s.scoring?.preset || 'custom',
    player: { id: p.id, name: p.name, pos: p.pos, nfl: p.team, injury: p.injury, fantasy_team: p.fantasy_team },
    points: playerPoints(st, s.scoring), proj: playerPoints(proj[id], s.scoring), breakdown,
  };
}

async function apiActivity(env) {
  const r = await env.DB.prepare(`SELECT x.id, x.created_at, x.week, x.type, x.detail, x.team_id, t.name AS team, p.name AS player, p.pos
    FROM transactions x LEFT JOIN teams t ON t.id = x.team_id LEFT JOIN players p ON p.id = x.player_id
    ORDER BY x.id DESC LIMIT 150`).all();
  return { items: r.results };
}

// ---------------------------------------------------------------- owner actions

async function teamRoster(env, teamId) {
  return (await env.DB.prepare(`SELECT r.player_id, r.slot, p.name, p.pos, p.team AS nfl
    FROM rosters r LEFT JOIN players p ON p.id = r.player_id WHERE r.team_id = ?`).bind(teamId).all()).results;
}

async function setLineup(env, team, body) {
  assertAlive(team);
  const s = await getSettings(env);
  const desired = body.slots || {};
  const [roster, games] = await Promise.all([teamRoster(env, team.id), loadGames(env, s.season, s.current_week)]);
  const gameBy = gameIndex(games);
  const now = Date.now();
  const counts = {};
  const updates = [];
  for (const r of roster) {
    const next = String(desired[r.player_id] ?? r.slot).toUpperCase();
    if (!(next in s.roster_slots)) throw new HttpError(400, `There is no ${next} slot in this league.`);
    if (next !== r.slot && isLocked(gameBy[r.nfl], now)) throw new HttpError(400, `${r.name} is locked because his game has started.`);
    if (!eligible(r.pos, next, s)) throw new HttpError(400, `${r.name} (${r.pos}) can't play ${next}.`);
    counts[next] = (counts[next] || 0) + 1;
    if (next !== r.slot) updates.push(env.DB.prepare('UPDATE rosters SET slot = ? WHERE player_id = ? AND team_id = ?').bind(next, r.player_id, team.id));
  }
  for (const [slot, n] of Object.entries(counts)) {
    if (slot !== 'BN' && n > Number(s.roster_slots[slot])) throw new HttpError(400, `Too many players at ${slot}: ${n} of ${s.roster_slots[slot]}.`);
  }
  if (updates.length) await env.DB.batch(updates);
  return { ok: true, changed: updates.length };
}

async function addFreeAgent(env, team, { player_id, drop_player_id }) {
  assertAlive(team);
  const s = await getSettings(env);
  if (!s.instant_free_agents) throw new HttpError(409, 'All adds go through waivers in this league. Place a bid instead.');
  const p = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(player_id).first();
  if (!p) throw new HttpError(404, 'Player not found.');
  if (await env.DB.prepare('SELECT 1 FROM rosters WHERE player_id = ?').bind(player_id).first()) throw new HttpError(409, `${p.name} is already on a roster.`);
  if (await env.DB.prepare('SELECT 1 FROM waiver_wire WHERE player_id = ?').bind(player_id).first()) throw new HttpError(409, `${p.name} is on waivers. Place a bid instead.`);
  const gameBy = gameIndex(await loadGames(env, s.season, s.current_week));
  const now = Date.now();
  if (isLocked(gameBy[p.team], now)) throw new HttpError(409, `${p.name}'s game has started. Try again after it ends.`);
  const roster = await teamRoster(env, team.id);
  let drop = null;
  if (drop_player_id) {
    drop = roster.find((r) => r.player_id === drop_player_id);
    if (!drop) throw new HttpError(400, 'The player you chose to drop is not on your roster.');
    if (isLocked(gameBy[drop.nfl], now)) throw new HttpError(409, `${drop.name} is locked and can't be dropped right now.`);
  } else if (roster.length >= rosterMax(s)) {
    throw new HttpError(409, 'Your roster is full. Choose a player to drop.');
  }
  const stmts = [];
  if (drop) stmts.push(...dropStatements(env, team, drop, s));
  stmts.push(env.DB.prepare("INSERT INTO rosters (player_id, team_id, slot) VALUES (?, ?, 'BN')").bind(player_id, team.id));
  stmts.push(env.DB.prepare("INSERT INTO transactions (week, type, team_id, player_id, detail) VALUES (?, 'add', ?, ?, 'Free agent')").bind(s.current_week, team.id, player_id));
  try { await env.DB.batch(stmts); } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, `${p.name} was just added by another team.`);
    throw e;
  }
  return { ok: true };
}

function dropStatements(env, team, drop, s) {
  return [
    env.DB.prepare('DELETE FROM rosters WHERE player_id = ? AND team_id = ?').bind(drop.player_id, team.id),
    env.DB.prepare('INSERT OR IGNORE INTO waiver_wire (player_id) VALUES (?)').bind(drop.player_id),
    env.DB.prepare("INSERT INTO transactions (week, type, team_id, player_id) VALUES (?, 'drop', ?, ?)").bind(s.current_week, team.id, drop.player_id),
  ];
}

async function dropPlayer(env, team, { player_id }) {
  assertAlive(team);
  const s = await getSettings(env);
  const roster = await teamRoster(env, team.id);
  const drop = roster.find((r) => r.player_id === player_id);
  if (!drop) throw new HttpError(400, 'That player is not on your roster.');
  const gameBy = gameIndex(await loadGames(env, s.season, s.current_week));
  if (isLocked(gameBy[drop.nfl], Date.now())) throw new HttpError(409, `${drop.name} is locked and can't be dropped right now.`);
  await env.DB.batch(dropStatements(env, team, drop, s));
  return { ok: true };
}

async function createClaim(env, team, { player_id, drop_player_id, bid }) {
  assertAlive(team);
  const amount = Number(bid);
  if (!Number.isInteger(amount) || amount < 0) throw new HttpError(400, 'Bids must be a whole number of dollars, $0 or more.');
  if (amount > team.faab) throw new HttpError(400, `You have $${team.faab} of FAAB left.`);
  const p = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(player_id).first();
  if (!p) throw new HttpError(404, 'Player not found.');
  if (await env.DB.prepare('SELECT 1 FROM rosters WHERE player_id = ?').bind(player_id).first()) throw new HttpError(409, `${p.name} is already on a roster.`);
  if (drop_player_id && !(await env.DB.prepare('SELECT 1 FROM rosters WHERE player_id = ? AND team_id = ?').bind(drop_player_id, team.id).first())) {
    throw new HttpError(400, 'The player you chose to drop is not on your roster.');
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM claims WHERE team_id = ? AND player_id = ? AND status = 'pending'").bind(team.id, player_id),
    env.DB.prepare('INSERT INTO claims (team_id, player_id, drop_player_id, bid) VALUES (?, ?, ?, ?)').bind(team.id, player_id, drop_player_id || null, amount),
  ]);
  return { ok: true };
}

async function cancelClaim(env, team, id) {
  const r = await env.DB.prepare("DELETE FROM claims WHERE id = ? AND team_id = ? AND status = 'pending'").bind(id, team.id).run();
  if (!r.meta.changes) throw new HttpError(404, 'That bid is no longer pending.');
  return { ok: true };
}

// ---------------------------------------------------------------- weekly cut

async function finalizeWeek(env, { force = false } = {}) {
  const s = await getSettings(env);
  // Pull final stats only if the 2-minute sync hasn't in the last 5 minutes (keeps this run light).
  const statsAt = Number((await getKV(env, `stats_at:${s.season}:${s.current_week}`)) || 0);
  if (Date.now() - statsAt > 5 * 60e3) {
    await syncGames(env, s.season, s.current_week);
    await syncBlob(env, 'stats', s.season, s.current_week, s);
  }
  const week = s.current_week;
  const wk = await buildWeek(env, s);
  if (!wk.games.length && !force) throw new HttpError(409, 'No NFL games found for this week. Sync live stats first.');
  const unfinished = wk.games.filter((g) => g.state !== 'post');
  if (unfinished.length && !force) throw new HttpError(409, `${unfinished.length} game(s) are not final yet. Use force to cut anyway.`);
  const already = await env.DB.prepare('SELECT COUNT(*) AS n FROM team_weeks WHERE season = ? AND week = ?').bind(s.season, week).first();
  if (already.n) throw new HttpError(409, `Week ${week} is already finalized.`);
  const alive = wk.teams.filter((t) => !t.eliminated_week);
  if (alive.length < 2) throw new HttpError(409, 'Only one team is left. The season is over.');

  // Lowest score is cut. Ties: lower season total, then lower bench points.
  const ordered = [...alive].sort((a, b) => a.points - b.points
    || (a.season_total + a.points) - (b.season_total + b.points)
    || a.bench_points - b.bench_points || b.id - a.id);
  const n = Math.min(cutsForWeek(s, week), alive.length - 1);
  const cut = ordered.slice(0, n);
  const cutIds = new Set(cut.map((t) => t.id));
  const ranked = [...alive].sort((a, b) => b.points - a.points);

  const stmts = [];
  const lineupStmt = env.DB.prepare('INSERT OR REPLACE INTO weekly_lineups (season, week, team_id, player_id, slot, points) VALUES (?, ?, ?, ?, ?, ?)');
  ranked.forEach((t, i) => {
    stmts.push(env.DB.prepare('INSERT INTO team_weeks (season, week, team_id, points, bench, rank, eliminated) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(s.season, week, t.id, t.points, t.bench_points, i + 1, cutIds.has(t.id) ? 1 : 0));
    for (const p of [...t.starters, ...t.bench]) stmts.push(lineupStmt.bind(s.season, week, t.id, p.id, p.slot, p.points));
  });
  for (const t of cut) {
    stmts.push(env.DB.prepare('UPDATE teams SET eliminated_week = ? WHERE id = ?').bind(week, t.id));
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO waiver_wire (player_id) SELECT player_id FROM rosters WHERE team_id = ?').bind(t.id));
    stmts.push(env.DB.prepare("UPDATE claims SET status = 'failed', reason = 'Team was cut', processed_at = datetime('now') WHERE team_id = ? AND status = 'pending'").bind(t.id));
    stmts.push(env.DB.prepare('DELETE FROM rosters WHERE team_id = ?').bind(t.id));
    stmts.push(env.DB.prepare("INSERT INTO transactions (week, type, team_id, detail) VALUES (?, 'eliminated', ?, ?)")
      .bind(week, t.id, `Cut with ${t.points.toFixed(2)} pts`));
  }
  await env.DB.batch(stmts);

  const remaining = alive.length - cut.length;
  s.current_week = week + 1;
  if (remaining === 1) s.champion_team_id = ordered[ordered.length - 1].id;
  await saveSettings(env, s);
  return { ok: true, week, eliminated: cut.map((t) => ({ id: t.id, name: t.name, points: t.points })), next_week: s.current_week, champion_team_id: s.champion_team_id };
}

// ---------------------------------------------------------------- FAAB waivers

async function processWaivers(env) {
  const s = await getSettings(env);
  const claims = (await env.DB.prepare("SELECT * FROM claims WHERE status = 'pending' ORDER BY created_at, id").all()).results;
  const teams = Object.fromEntries((await env.DB.prepare('SELECT id, name, faab, eliminated_week FROM teams').all()).results.map((t) => [t.id, t]));
  const owner = Object.fromEntries((await env.DB.prepare('SELECT player_id, team_id FROM rosters').all()).results.map((r) => [r.player_id, r.team_id]));
  const totals = Object.fromEntries((await env.DB.prepare('SELECT team_id, SUM(points) AS total FROM team_weeks WHERE season = ? GROUP BY team_id').bind(s.season).all()).results.map((r) => [r.team_id, r.total || 0]));
  const counts = {};
  for (const tid of Object.values(owner)) counts[tid] = (counts[tid] || 0) + 1;
  const max = rosterMax(s);

  const stmts = [];
  const newlyDropped = [];
  const resolve = (c, status, reason) => stmts.push(env.DB.prepare("UPDATE claims SET status = ?, reason = ?, processed_at = datetime('now') WHERE id = ?").bind(status, reason, c.id));
  let pending = [...claims];
  let won = 0;
  while (pending.length) {
    // Highest bid wins. Ties go to the team with the lower season total, then the earlier bid.
    pending.sort((a, b) => b.bid - a.bid || (totals[a.team_id] || 0) - (totals[b.team_id] || 0) || a.id - b.id);
    const c = pending.shift();
    const team = teams[c.team_id];
    let reason = null;
    if (!team || team.eliminated_week) reason = 'Team was cut';
    else if (owner[c.player_id]) reason = 'Player was already claimed';
    else if (c.bid > team.faab) reason = 'Not enough FAAB left';
    else if (c.drop_player_id && owner[c.drop_player_id] !== c.team_id) reason = 'Drop player is no longer on the roster';
    else if (!c.drop_player_id && (counts[c.team_id] || 0) >= max) reason = 'Roster is full and no drop was chosen';
    if (reason) { resolve(c, reason === 'Player was already claimed' ? 'lost' : 'failed', reason); continue; }

    team.faab -= c.bid;
    owner[c.player_id] = c.team_id;
    counts[c.team_id] = (counts[c.team_id] || 0) + 1;
    stmts.push(env.DB.prepare("INSERT INTO rosters (player_id, team_id, slot) VALUES (?, ?, 'BN')").bind(c.player_id, c.team_id));
    stmts.push(env.DB.prepare("INSERT INTO transactions (week, type, team_id, player_id, detail) VALUES (?, 'waiver', ?, ?, ?)").bind(s.current_week, c.team_id, c.player_id, `$${c.bid}`));
    if (c.drop_player_id) {
      delete owner[c.drop_player_id];
      counts[c.team_id] -= 1;
      newlyDropped.push(c.drop_player_id);
      stmts.push(env.DB.prepare('DELETE FROM rosters WHERE player_id = ?').bind(c.drop_player_id));
      stmts.push(env.DB.prepare("INSERT INTO transactions (week, type, team_id, player_id) VALUES (?, 'drop', ?, ?)").bind(s.current_week, c.team_id, c.drop_player_id));
    }
    resolve(c, 'won', `Won for $${c.bid}`);
    won += 1;
    for (const o of pending.filter((x) => x.player_id === c.player_id)) resolve(o, 'lost', `Outbid by ${team.name}`);
    pending = pending.filter((x) => x.player_id !== c.player_id);
  }
  for (const t of Object.values(teams)) stmts.push(env.DB.prepare('UPDATE teams SET faab = ? WHERE id = ?').bind(t.faab, t.id));
  stmts.push(env.DB.prepare('DELETE FROM waiver_wire'));
  for (const pid of newlyDropped) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO waiver_wire (player_id) VALUES (?)').bind(pid));
  await env.DB.batch(stmts);
  s.last_waiver_run = new Date().toISOString();
  await saveSettings(env, s);
  return { ok: true, processed: claims.length, won };
}

// ---------------------------------------------------------------- commissioner

async function adminOverview(env) {
  const s = await getSettings(env);
  const teams = (await env.DB.prepare(`SELECT t.id, t.name, t.owner, t.email, t.token, t.faab, t.eliminated_week,
      (SELECT COUNT(*) FROM rosters r WHERE r.team_id = t.id) AS roster_size FROM teams t ORDER BY t.name`).all()).results;
  const playerCount = (await env.DB.prepare('SELECT COUNT(*) AS n FROM players').first()).n;
  const pendingClaims = (await env.DB.prepare("SELECT COUNT(*) AS n FROM claims WHERE status = 'pending'").first()).n;
  const wk = s.season ? `${s.season}:${s.current_week}` : '';
  return {
    settings: s, teams, player_count: playerCount, pending_claims: pendingClaims,
    synced: {
      players: Number((await getKV(env, 'players_at')) || 0),
      games: Number((await getKV(env, `games_at:${wk}`)) || 0),
      stats: Number((await getKV(env, `stats_at:${wk}`)) || 0),
      proj: Number((await getKV(env, `proj_at:${wk}`)) || 0),
    },
  };
}

async function adminSettings(env, body) {
  const current = await getSettings(env);
  const next = { ...current, ...(body.settings || {}) };
  next.season = Number(next.season) || current.season;
  next.current_week = Math.max(1, Math.min(18, Number(next.current_week) || current.current_week || 1));
  next.faab_budget = Math.max(0, Number(next.faab_budget) || 0);
  next.cuts_per_week = Math.max(1, Number(next.cuts_per_week) || 1);
  if (!next.roster_slots || typeof next.roster_slots !== 'object') throw new HttpError(400, 'roster_slots must be an object like {"QB":1,"BN":6}.');
  for (const [k, v] of Object.entries(next.roster_slots)) {
    if (!Number.isInteger(Number(v)) || Number(v) < 0) throw new HttpError(400, `roster_slots.${k} must be a whole number.`);
  }
  if (!('BN' in next.roster_slots)) throw new HttpError(400, 'roster_slots needs a BN (bench) entry.');
  const weights = next.scoring?.weights || {};
  for (const [k, v] of Object.entries(weights)) if (!Number.isFinite(Number(v))) throw new HttpError(400, `Scoring weight ${k} must be a number.`);
  await saveSettings(env, next);
  // Re-pull stats so any newly added scoring keys are captured.
  let sync = null;
  try { sync = await syncLive(env, { force: true }); } catch (e) { sync = { error: e.message }; }
  return { ok: true, settings: next, sync };
}

async function adminUpdateTeam(env, id, body) {
  const t = await env.DB.prepare('SELECT * FROM teams WHERE id = ?').bind(id).first();
  if (!t) throw new HttpError(404, 'Team not found.');
  const name = body.name ?? t.name;
  const owner = body.owner ?? t.owner;
  const email = body.email ?? t.email;
  const faab = body.faab != null ? Number(body.faab) : t.faab;
  const elim = 'eliminated_week' in body ? (body.eliminated_week ? Number(body.eliminated_week) : null) : t.eliminated_week;
  await env.DB.prepare('UPDATE teams SET name = ?, owner = ?, email = ?, faab = ?, eliminated_week = ? WHERE id = ?')
    .bind(name, owner, email, faab, elim, id).run();
  return { ok: true };
}

const newToken = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);

async function adminNewToken(env, id) {
  const token = newToken();
  const r = await env.DB.prepare('UPDATE teams SET token = ? WHERE id = ?').bind(token, id).run();
  if (!r.meta.changes) throw new HttpError(404, 'Team not found.');
  return { ok: true, token };
}

async function adminReset(env, body) {
  if (body.confirm !== 'RESET') throw new HttpError(400, 'Type RESET to confirm.');
  await env.DB.batch(['teams', 'rosters', 'claims', 'team_weeks', 'weekly_lineups', 'waiver_wire', 'transactions']
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const s = await getSettings(env);
  s.champion_team_id = null;
  s.last_waiver_run = null;
  await saveSettings(env, s);
  return { ok: true };
}

// ---------------------------------------------------------------- import

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

function csvToTeams(csv) {
  const rows = parseCSV(csv);
  if (rows.length < 2) throw new HttpError(400, 'The CSV needs a header row and at least one data row.');
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = (names) => header.findIndex((h) => names.includes(h));
  const ix = {
    team: col(['team', 'team_name', 'fantasy_team']), owner: col(['owner', 'manager', 'owner_name']),
    email: col(['email', 'owner_email']), player: col(['player', 'player_name', 'name']),
    pos: col(['pos', 'position']), nfl: col(['nfl_team', 'nfl', 'pro_team']), slot: col(['slot', 'lineup_slot']),
    faab: col(['faab', 'budget']), id: col(['player_id', 'sleeper_id']),
  };
  if (ix.team < 0) throw new HttpError(400, 'The CSV needs a "team" column.');
  const teams = new Map();
  for (const r of rows.slice(1)) {
    const get = (k) => (ix[k] >= 0 ? (r[ix[k]] || '').trim() : '');
    const name = get('team');
    if (!name) continue;
    if (!teams.has(name)) teams.set(name, { name, owner: '', email: '', faab: null, players: [] });
    const t = teams.get(name);
    if (get('owner')) t.owner = get('owner');
    if (get('email')) t.email = get('email');
    if (get('faab')) t.faab = Number(get('faab'));
    if (get('player') || get('id')) t.players.push({ name: get('player'), pos: get('pos'), team: get('nfl'), slot: get('slot'), id: get('id') });
  }
  return [...teams.values()];
}

const normName = (n) => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[.'’`]/g, '').replace(/-/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
const normPos = (p) => {
  const x = String(p || '').toUpperCase().replace(/[^A-Z]/g, '');
  return { DST: 'DEF', D: 'DEF', DEFENSE: 'DEF', PK: 'K' }[x] || x;
};

function matchPlayer(pl, all, idx, byId) {
  if (pl.id && byId[pl.id]) return byId[pl.id];
  const pos = normPos(pl.pos);
  const team = pl.team ? normTeam(pl.team.toUpperCase()) : null;
  if (pos === 'DEF' && team && byId[team]) return byId[team];
  const key = normName(pl.name);
  let cands = idx.get(key) || [];
  if (!cands.length && (pos === 'DEF' || !pos)) cands = all.filter((p) => p.pos === 'DEF' && key && normName(p.name).includes(key));
  if (pos) cands = cands.filter((c) => c.pos === pos);
  if (cands.length > 1 && team) cands = cands.filter((c) => c.team === team);
  if (cands.length > 1) cands = cands.filter((c) => c.team);
  return cands.length === 1 ? cands[0] : null;
}

async function autoLineup(env, teamId, s, proj) {
  const roster = (await teamRoster(env, teamId)).map((r) => ({ ...r, proj: playerPoints(proj[r.player_id], s.scoring) }))
    .sort((a, b) => b.proj - a.proj);
  const flexKeys = Object.keys(s.flex_eligibility || {});
  const slotList = [];
  for (const [slot, n] of Object.entries(s.roster_slots)) if (slot !== 'BN' && !flexKeys.includes(slot)) for (let i = 0; i < n; i++) slotList.push(slot);
  for (const [slot, n] of Object.entries(s.roster_slots)) if (flexKeys.includes(slot)) for (let i = 0; i < n; i++) slotList.push(slot);
  const used = new Set();
  const stmts = [];
  for (const slot of slotList) {
    const pick = roster.find((r) => !used.has(r.player_id) && eligible(r.pos, slot, s));
    if (!pick) continue;
    used.add(pick.player_id);
    stmts.push(env.DB.prepare('UPDATE rosters SET slot = ? WHERE player_id = ?').bind(slot, pick.player_id));
  }
  if (stmts.length) await env.DB.batch(stmts);
}

async function adminImport(env, body) {
  const incoming = body.csv ? csvToTeams(body.csv) : body.teams;
  if (!Array.isArray(incoming) || !incoming.length) throw new HttpError(400, 'Nothing to import. Paste CSV rows or send a teams array.');
  if (!(await env.DB.prepare('SELECT COUNT(*) AS n FROM players').first()).n) throw new HttpError(409, 'Load the NFL player list first (Commissioner > Sync NFL player list).');
  const s = await ensureSeasonWeek(env, await getSettings(env));
  const all = (await env.DB.prepare('SELECT id, name, pos, team FROM players').all()).results;
  const proj = await loadBlob(env, 'proj', s.season, s.current_week);
  const byId = Object.fromEntries(all.map((p) => [p.id, p]));
  const idx = new Map();
  for (const p of all) {
    const k = normName(p.name);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(p);
  }
  if (body.replace) {
    await env.DB.batch(['teams', 'rosters', 'claims', 'team_weeks', 'weekly_lineups', 'waiver_wire', 'transactions']
      .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    s.champion_team_id = null;
    await saveSettings(env, s);
  }
  const existing = (await env.DB.prepare('SELECT id, name, token FROM teams').all()).results;
  const report = [];
  const unmatched = [];
  const claimed = new Map();
  for (const t of incoming) {
    if (!t.name) continue;
    let row = existing.find((e) => e.name.toLowerCase() === String(t.name).toLowerCase());
    if (!row) {
      row = await env.DB.prepare('INSERT INTO teams (name, owner, email, token, faab) VALUES (?, ?, ?, ?, ?) RETURNING id, name, token')
        .bind(t.name, t.owner || '', t.email || null, newToken(), Number.isFinite(t.faab) ? t.faab : s.faab_budget).first();
      existing.push(row);
    } else {
      await env.DB.prepare('UPDATE teams SET owner = COALESCE(NULLIF(?, \'\'), owner), email = COALESCE(NULLIF(?, \'\'), email) WHERE id = ?')
        .bind(t.owner || '', t.email || '', row.id).run();
    }
    const stmts = [];
    let anySlot = false;
    let added = 0;
    for (const pl of t.players || []) {
      const m = matchPlayer(pl, all, idx, byId);
      if (!m) { unmatched.push({ team: t.name, player: pl.name || pl.id, pos: pl.pos || '', nfl: pl.team || '' }); continue; }
      if (claimed.has(m.id)) { unmatched.push({ team: t.name, player: m.name, pos: m.pos, nfl: m.team, note: `Also listed on ${claimed.get(m.id)}` }); continue; }
      claimed.set(m.id, t.name);
      let slot = String(pl.slot || '').toUpperCase();
      if (!(slot in s.roster_slots) || !eligible(m.pos, slot, s)) slot = 'BN';
      if (slot !== 'BN') anySlot = true;
      stmts.push(env.DB.prepare(`INSERT INTO rosters (player_id, team_id, slot) VALUES (?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET team_id = excluded.team_id, slot = excluded.slot`).bind(m.id, row.id, slot));
      added += 1;
    }
    if (stmts.length) await env.DB.batch(stmts);
    if (added && !anySlot) await autoLineup(env, row.id, s, proj);
    report.push({ id: row.id, team: row.name, players: added, token: row.token });
  }
  await env.DB.prepare("INSERT INTO transactions (week, type, detail) VALUES (?, 'import', ?)")
    .bind(s.current_week, `Imported ${report.length} teams`).run();
  return { ok: true, teams: report, unmatched };
}
