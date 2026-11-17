# Guillotine League

A Yahoo-style guillotine fantasy football site on Cloudflare Workers + D1. Every week the lowest-scoring team is cut, its players go to waivers, and survivors bid FAAB for them. Last team standing wins.

## What's included

- **Chopping block**: live scoreboard of surviving teams ranked by projected score, with the cut line and the gap to safety. Auto-refreshes every 30 seconds.
- **Team pages**: starters, bench, live points, projections, game status. Owners set lineups (players lock at kickoff), drop players, and track bids.
- **Players**: search and filter unrostered players, add free agents instantly, or place blind FAAB bids on players on waivers. Click any player for his stat line and point breakdown.
- **Graveyard** and **Activity** feeds.
- **Commissioner page** (`/#admin`): CSV import of owners and rosters, owner links, league settings and scoring, manual sync, finalize week, process waivers, reset.

## Live data

| Source | Used for | Notes |
|---|---|---|
| Sleeper API | Player list, live stats, projections | Free, no key. Stats refresh every 2 minutes during games. |
| ESPN scoreboard | Game clock, scores, kickoff times (lineup locks) | Free, no key. |

Both are unofficial public endpoints. They're widely used by fantasy tools but can change without notice. If this ever goes beyond a friends league, consider a licensed feed (SportsDataIO, Sportradar).

## Deploy without installing Node (GitHub + Cloudflare builds)

Cloudflare builds and deploys the project from a GitHub repo, so nothing runs on your computer.

1. **Create the database.** In the Cloudflare dashboard, go to Storage & Databases > D1 > Create. Name it `guillotine`. Copy its Database ID into `wrangler.toml` (replace `REPLACE_WITH_YOUR_D1_ID`). You don't need to create tables: the Worker creates them on first run.
2. **Put the project in a GitHub repo.** Upload the folder contents (not the zip) to a new private repo.
3. **Connect it.** In the dashboard, go to Workers & Pages > Create > Import a repository, pick the repo, and keep the default deploy command (`npx wrangler deploy`). Each push to the repo redeploys.
4. **Set the commissioner password.** Open the Worker > Settings > Variables and Secrets > Add, type Secret, name `ADMIN_KEY`.
5. **Load players and import.** Open `https://guillotine-league.<your-subdomain>.workers.dev/#admin`, sign in with your `ADMIN_KEY`, and import your CSV. The first import loads the NFL player list automatically.

To use your own domain, add a Custom Domain to the Worker under Settings > Domains & Routes.

If you'd rather deploy from your computer, install a current Node LTS and run `npm install`, `npx wrangler login`, then `npm run deploy`.

## Cloudflare plan

The site runs on the **free Workers plan**. It was built around the free plan's limits:

- **10 ms of CPU per run.** The heaviest jobs (one position of the player list, one live stats pull) measured about 7 ms each in testing. Each scheduled run does at most one of them.
- **5 cron triggers per account.** The site uses one. Weekly and daily jobs are scheduled inside it.
- **D1 free tier.** A full Sunday of live syncing uses a few thousand row writes, well under the 100,000 per day allowance.

The headroom on CPU is real but not huge. If the Worker's logs ever show "Exceeded CPU Limit", Workers Paid ($5/month) removes the issue with no code changes.

## Import owners and rosters

On the Commissioner page, paste or upload a CSV (see `sample-import.csv`). One row per player:

| Column | Required | Notes |
|---|---|---|
| team | Yes | Team name. Existing teams are matched by name and updated. |
| owner, email | No | Can be on any row for that team. |
| player | Yes* | Player name. Suffixes, punctuation and accents are ignored when matching. |
| pos | No | Helps disambiguate. DST, D/ST and DEF all work. |
| nfl_team | No | Helps disambiguate players with the same name. For defenses, the abbreviation alone (KC) is enough. |
| player_id | No* | Sleeper player ID. Overrides name matching. |
| slot | No | QB, RB, WR, TE, FLEX, K, DEF, BN. If a team has no slots, its lineup is auto-filled by projection. |
| faab | No | Starting budget. Defaults to the league setting (1000). |

Any player who can't be matched is listed after import so you can fix those rows and re-import. Check **Replace all existing teams** to start over cleanly.

After import, copy each team's private link from the Teams table and send it to the owner. The link is their login; regenerate it if one leaks.

## Weekly cycle (all times UTC)

A single cron runs every 2 minutes. Each run syncs live data and, when one is due, does one of these jobs:

| When | What |
|---|---|
| While games are on | Pull scores and stats. Upstream APIs are only called when games are live, about to start, or data is stale. |
| Daily | Refresh the NFL player list one position at a time (team changes, injuries). |
| Tuesday from 10:00 | Once every game is final: lowest score is cut (ties go to lower season total, then lower bench points), its roster goes to waivers, week advances. |
| Wednesday from 16:00 | Process FAAB claims. Highest bid wins; ties go to the team with the lower season total, then the earlier bid. Unclaimed players become free agents. |

Turn off automation with `auto_finalize` or `auto_waivers` in settings and use the Commissioner buttons instead.

## Settings and custom scoring

Settings are JSON on the Commissioner page. Key fields:

- `current_week`: set this when you start the league mid-season.
- `cuts_per_week` and `cuts_overrides` (for example `{"1": 2}` to cut two teams in week 1).
- `roster_slots` and `flex_eligibility`: add `"SUPERFLEX": 1` to `roster_slots` for a superflex league.
- `instant_free_agents`: set to false to make every add go through FAAB.
- `scoring.preset`: `custom` uses `scoring.weights`; `ppr`, `half_ppr`, or `std` uses Sleeper's computed points.
- `scoring.weights`: points per Sleeper stat key. Defaults are half PPR. Add any key Sleeper reports (for example `bonus_rec_te` for TE premium, or `pass_cmp` for completions). Open any player's stat line to see the keys he has. Saving settings re-pulls the week's stats so new keys are captured.

Default weights were verified against Sleeper's own half-PPR totals.

## Project layout

```
wrangler.toml            Worker, D1 binding, cron schedule
migrations/0001_init.sql Database schema (optional; the Worker also creates tables itself)
src/index.js             API, live sync, cut, waivers, import
public/                  Front end (index.html, app.js, styles.css), no build step
sample-import.csv        Import template
```
