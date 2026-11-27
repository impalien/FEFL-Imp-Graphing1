import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pool } from './database/db.ts';
import { STAT_KEYS } from './types.ts';
import type { Pos, RawPlayer, RawRound, RawSquad, StatLine } from './types.ts';
import type { EventCount, FixtureRow, MatchDelta, PlayerAt } from './analytics/teamMetrics.ts';
import type { ClubRow, ExportInput, GameweekRow, PlayerRow } from './export.ts';
import type { CardEvent } from './analytics/cardMetrics.ts';

const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex');
const N = (v: unknown) => (v == null ? null : Number(v));
const J = (v: unknown) => (v == null ? null : JSON.stringify(v));

export async function lastRunAt(): Promise<Date | null> {
  const r = await pool.query(`select max(finished_at) t from collection_runs where status = 'ok'`);
  return r.rows[0].t;
}
export async function startRun(trigger: string): Promise<number> {
  const r = await pool.query(`insert into collection_runs (trigger) values ($1) returning id`, [trigger]);
  return Number(r.rows[0].id);
}
export const finishRun = (id: number, status: string, note: string) => pool.query(`update collection_runs set finished_at = now(), status = $2, note = $3 where id = $1`, [id, status, note]);

/** Keep the untouched JSON (gzipped). Skipped when it is byte-for-byte the same as the last copy we hold. */
export async function storeRaw(runId: number, endpoint: string, text: string) {
  await pool.query(
    `insert into raw_snapshots (run_id, endpoint, sha1, bytes, gz) select $1::bigint, $2::text, $3::text, $4::int, $5::bytea
     where not exists (select 1 from raw_snapshots where endpoint = $2::text and sha1 = $3::text)`, [runId, endpoint, sha(text), text.length, zlib.gzipSync(text)]);
}

export async function upsertClubs(rows: RawSquad[]) {
  await pool.query(
    `insert into clubs (id, competition_id, name, short_name, abbreviation, bg, tx)
     select * from unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
     on conflict (id) do update set competition_id = excluded.competition_id, name = excluded.name, short_name = excluded.short_name, abbreviation = excluded.abbreviation, bg = excluded.bg, tx = excluded.tx, updated_at = now()`,
    [rows.map((r) => r.id), rows.map((r) => r.competitionId), rows.map((r) => r.name), rows.map((r) => r.shortName), rows.map((r) => r.abbreviation), rows.map((r) => r.backgroundColor), rows.map((r) => r.textColor)]);
}
export async function upsertPlayers(rows: RawPlayer[]) {
  await pool.query(
    `insert into players (id, club_id, competition_id, first_name, last_name, display_name, position)
     select * from unnest($1::int[], $2::int[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[])
     on conflict (id) do update set club_id = excluded.club_id, competition_id = excluded.competition_id, display_name = excluded.display_name, position = excluded.position, updated_at = now()`,
    [rows.map((r) => r.id), rows.map((r) => r.squadId), rows.map((r) => r.competitionId), rows.map((r) => r.firstName), rows.map((r) => r.lastName), rows.map((r) => r.displayName), rows.map((r) => r.position)]);
}
export async function upsertRounds(rounds: RawRound[]) {
  for (const r of rounds) {
    await pool.query(
      `insert into gameweeks (id, round_number, name, status, lockout_at, completed_at, avg_points) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set status = excluded.status, lockout_at = excluded.lockout_at, completed_at = excluded.completed_at, avg_points = excluded.avg_points, updated_at = now()`,
      [r.id, r.roundNumber, r.name, r.status, r.lockoutDate, r.completedAt, r.avgPoints]);
  }
  const g = rounds.flatMap((r) => r.games.map((x) => ({ ...x, rid: r.id })));
  await pool.query(
    `insert into fixtures (id, gameweek_id, competition_id, kickoff, home_id, away_id, status, finalized, home_score, away_score)
     select * from unnest($1::bigint[], $2::int[], $3::int[], $4::timestamptz[], $5::int[], $6::int[], $7::text[], $8::boolean[], $9::int[], $10::int[])
     on conflict (id) do update set kickoff = excluded.kickoff, status = excluded.status, finalized = excluded.finalized, home_score = excluded.home_score, away_score = excluded.away_score, updated_at = now()`,
    [g.map((x) => x.id), g.map((x) => x.rid), g.map((x) => x.competitionId), g.map((x) => x.date), g.map((x) => x.homeId), g.map((x) => x.awayId), g.map((x) => x.status), g.map((x) => x.isFinalized), g.map((x) => x.homeScore), g.map((x) => x.awayScore)]);
}

async function latestHashes(table: string, idCol: string): Promise<Map<number, string>> {
  const r = await pool.query(`select distinct on (${idCol}) ${idCol} as id, state_hash from ${table} order by ${idCol}, collected_at desc`);
  return new Map(r.rows.map((x) => [Number(x.id), x.state_hash as string]));
}

/** Append a row only when something changed since the last row we hold. Returns how many rows were added. */
export async function appendPlayerSnapshots(runId: number, rows: RawPlayer[]): Promise<number> {
  const last = await latestHashes('player_snapshots', 'player_id');
  const fresh = rows.map((p) => ({ p, h: sha(JSON.stringify([p.status, p.totalPoints, p.averagePoints, p.roundPoints, p.percentSelected, STAT_KEYS.map((k) => p[k]), p.lastThree, p.suspensionDetails, p.injuryDetails])) })).filter((x) => last.get(x.p.id) !== x.h);
  if (!fresh.length) return 0;
  const c = <T,>(f: (x: { p: RawPlayer; h: string }) => T) => fresh.map(f);
  await pool.query(
    `insert into player_snapshots (run_id, player_id, state_hash, status, total_points, average_points, round_points, percent_selected, appearances, goals, assists, key_passes, shots_on_target, clean_sheets, clearances, blocks, tackles, interceptions, saves, last_three, suspension, injury)
     select $1::bigint, a.pid, a.h, a.st, a.tp, a.av, a.rp, a.ps, a.ap, a.g, a.a, a.kp, a.sot, a.cs, a.cl, a.bl, a.tk, a.it, a.sv, a.l3::jsonb, a.su::jsonb, a.inj::jsonb
     from unnest($2::int[], $3::text[], $4::text[], $5::int[], $6::numeric[], $7::int[], $8::numeric[], $9::int[], $10::int[], $11::int[], $12::int[], $13::int[], $14::int[], $15::int[], $16::int[], $17::int[], $18::int[], $19::int[], $20::text[], $21::text[], $22::text[])
     as a(pid, h, st, tp, av, rp, ps, ap, g, a, kp, sot, cs, cl, bl, tk, it, sv, l3, su, inj)`,
    [runId, c((x) => x.p.id), c((x) => x.h), c((x) => x.p.status), c((x) => x.p.totalPoints), c((x) => x.p.averagePoints), c((x) => x.p.roundPoints), c((x) => x.p.percentSelected),
      c((x) => x.p.appearances), c((x) => x.p.goalsScored), c((x) => x.p.assists), c((x) => x.p.keyPasses), c((x) => x.p.shotsOnTarget), c((x) => x.p.cleanSheets), c((x) => x.p.clearances), c((x) => x.p.blocks), c((x) => x.p.tackles), c((x) => x.p.interceptions), c((x) => x.p.saves),
      c((x) => J(x.p.lastThree)), c((x) => J(x.p.suspensionDetails)), c((x) => J(x.p.injuryDetails))]);
  return fresh.length;
}
export async function appendClubSnapshots(runId: number, rows: RawSquad[]): Promise<number> {
  const last = await latestHashes('club_snapshots', 'club_id');
  const fresh = rows.map((s) => ({ s, h: sha(JSON.stringify([s.totalPoints, s.averagePoints, s.roundPoints, s.percentSelected, s.leaguePosition, s.fdrHome, s.fdrAway, s.last3Form, s.lastThree])) })).filter((x) => last.get(x.s.id) !== x.h);
  for (const { s, h } of fresh) {
    await pool.query(
      `insert into club_snapshots (run_id, club_id, state_hash, total_points, average_points, round_points, percent_selected, league_position, fdr_home, fdr_away, last3_form, last_three) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [runId, s.id, h, s.totalPoints, s.averagePoints, s.roundPoints, s.percentSelected, s.leaguePosition, s.fdrHome, s.fdrAway, (s.last3Form ?? []).join(''), J(s.lastThree)]);
  }
  return fresh.length;
}
export async function appendFixtureSnapshots(runId: number, rounds: RawRound[]): Promise<number> {
  const last = await latestHashes('fixture_snapshots', 'fixture_id');
  let n = 0;
  for (const g of rounds.flatMap((r) => r.games)) {
    const h = sha(JSON.stringify([g.status, g.isFinalized, g.homeScore, g.awayScore, g.date]));
    if (last.get(g.id) === h) continue;
    await pool.query(`insert into fixture_snapshots (run_id, fixture_id, state_hash, status, finalized, home_score, away_score) values ($1, $2, $3, $4, $5, $6, $7)`, [runId, g.id, h, g.status, g.isFinalized, g.homeScore, g.awayScore]);
    n++;
  }
  return n;
}
/** Insert-only, duplicates ignored. Every event in rounds.json is stored each run, so cards from before the collector started are backfilled too. */
export async function insertEvents(rounds: RawRound[], _now: Date): Promise<void> {
  const ev = rounds.flatMap((r) => r.games).flatMap((g) => (g.events ?? []).map((e) => ({ g: g.id, e })));
  for (let i = 0; i < ev.length; i += 5000) await insertEventChunk(ev.slice(i, i + 5000));
}
async function insertEventChunk(ev: { g: number; e: RawRound['games'][number]['events'][number] }[]): Promise<void> {
  if (!ev.length) return;
  await pool.query(
    `insert into match_events (fixture_id, player_id, type, minute, period, side, assist_player_id)
     select * from unnest($1::bigint[], $2::bigint[], $3::text[], $4::int[], $5::text[], $6::text[], $7::bigint[]) on conflict do nothing`,
    [ev.map((x) => x.g), ev.map((x) => x.e.playerId), ev.map((x) => x.e.type), ev.map((x) => x.e.minute ?? 0), ev.map((x) => x.e.period ?? ''), ev.map((x) => x.e.side), ev.map((x) => x.e.assistPlayerId)]);
}

/** Every player's numbers as they stood at a moment in time (latest snapshot at or before it). */
export async function playersAt(t: Date): Promise<Map<number, PlayerAt>> {
  const r = await pool.query(
    `select distinct on (s.player_id) s.player_id, p.club_id, p.position, s.appearances, s.goals, s.assists, s.key_passes, s.shots_on_target, s.clean_sheets, s.clearances, s.blocks, s.tackles, s.interceptions, s.saves
     from player_snapshots s join players p on p.id = s.player_id where s.collected_at <= $1 order by s.player_id, s.collected_at desc`, [t]);
  return new Map(r.rows.map((x) => [Number(x.player_id), { id: Number(x.player_id), club: Number(x.club_id), pos: x.position as Pos, s: { appearances: x.appearances, goalsScored: x.goals, assists: x.assists, keyPasses: x.key_passes, shotsOnTarget: x.shots_on_target, cleanSheets: x.clean_sheets, clearances: x.clearances, blocks: x.blocks, tackles: x.tackles, interceptions: x.interceptions, saves: x.saves } as StatLine }]));
}
export async function processedRounds(): Promise<Set<number>> {
  return new Set((await pool.query(`select round_id from round_processing`)).rows.map((x) => Number(x.round_id)));
}
export const markRound = (id: number, status: string, note: string) => pool.query(`insert into round_processing (round_id, status, note) values ($1, $2, $3) on conflict do nothing`, [id, status, note]);
export async function saveDeltas(d: MatchDelta[]) {
  if (!d.length) return;
  const k = (f: (x: MatchDelta) => unknown) => d.map(f);
  await pool.query(
    `insert into player_match_deltas (fixture_id, player_id, club_id, opp_id, position, appearances, goals, assists, key_passes, shots_on_target, clean_sheets, clearances, blocks, tackles, interceptions, saves)
     select * from unnest($1::bigint[], $2::int[], $3::int[], $4::int[], $5::text[], $6::int[], $7::int[], $8::int[], $9::int[], $10::int[], $11::int[], $12::int[], $13::int[], $14::int[], $15::int[], $16::int[]) on conflict do nothing`,
    [k((x) => x.fixtureId), k((x) => x.playerId), k((x) => x.club), k((x) => x.opp), k((x) => x.pos), ...STAT_KEYS.map((s) => k((x) => x.d[s]))]);
}

export async function loadExportInput(now: Date): Promise<Omit<ExportInput, 'now'>> {
  const q = (s: string) => pool.query(s).then((r) => r.rows);
  const [pl, cl, fx, ev, de, gw, cd, runs, snaps, proc] = await Promise.all([
    q(`select distinct on (s.player_id) s.*, p.club_id, p.competition_id, p.display_name, p.position from player_snapshots s join players p on p.id = s.player_id order by s.player_id, s.collected_at desc`),
    q(`select distinct on (s.club_id) s.*, c.competition_id, c.name, c.short_name, c.abbreviation, c.bg, c.tx from club_snapshots s join clubs c on c.id = s.club_id order by s.club_id, s.collected_at desc`),
    q(`select f.id, f.finalized, f.home_id, f.away_id, f.home_score, f.away_score, f.kickoff, f.status, g.round_number from fixtures f left join gameweeks g on g.id = f.gameweek_id`),
    q(`select fixture_id, side, type, count(*)::int n from match_events group by 1, 2, 3`),
    q(`select * from player_match_deltas`),
    q(`select id, round_number, status, lockout_at from gameweeks order by round_number`),
    q(`select fixture_id, player_id, type from match_events where type ilike '%yellow%' or type ilike '%red%'`),
    q(`select count(*)::int n from collection_runs where status = 'ok'`),
    q(`select count(*)::int n from player_snapshots`),
    q(`select status, count(*)::int n from round_processing group by 1`),
  ]);
  const players: PlayerRow[] = pl.map((s) => ({ id: s.player_id, club: s.club_id, comp: s.competition_id, name: s.display_name, pos: s.position, status: s.status, pts: s.total_points, avg: N(s.average_points) ?? 0, rp: s.round_points, l3: s.last_three ?? [], own: N(s.percent_selected) ?? 0, inj: s.injury, sus: s.suspension,
    s: { appearances: s.appearances, goalsScored: s.goals, assists: s.assists, keyPasses: s.key_passes, shotsOnTarget: s.shots_on_target, cleanSheets: s.clean_sheets, clearances: s.clearances, blocks: s.blocks, tackles: s.tackles, interceptions: s.interceptions, saves: s.saves } }));
  const clubs: ClubRow[] = cl.map((s) => ({ id: s.club_id, comp: s.competition_id, name: s.name, short: s.short_name, abbr: s.abbreviation, pos: s.league_position, form: (s.last3_form ?? '').split('').filter(Boolean), fdrH: s.fdr_home, fdrA: s.fdr_away, bg: s.bg, tx: s.tx, pts: s.total_points, l3: s.last_three ?? [], own: N(s.percent_selected) ?? 0 }));
  const fixtures: FixtureRow[] = fx.map((f) => ({ id: Number(f.id), finalized: f.finalized, home: f.home_id, away: f.away_id, hs: f.home_score, as: f.away_score, kickoff: f.kickoff ? new Date(f.kickoff).toISOString() : null, status: f.status ?? '', round: f.round_number ?? null }));
  const events: EventCount[] = ev.map((e) => ({ fixture: Number(e.fixture_id), side: e.side, type: e.type, n: e.n }));
  const deltas: MatchDelta[] = de.map((d) => ({ fixtureId: Number(d.fixture_id), playerId: d.player_id, club: d.club_id, opp: d.opp_id, pos: d.position, d: { appearances: d.appearances, goalsScored: d.goals, assists: d.assists, keyPasses: d.key_passes, shotsOnTarget: d.shots_on_target, cleanSheets: d.clean_sheets, clearances: d.clearances, blocks: d.blocks, tackles: d.tackles, interceptions: d.interceptions, saves: d.saves } }));
  const done = gw.filter((g) => g.status === 'completed').length, open = gw.find((g) => g.status !== 'completed');
  const p = Object.fromEntries(proc.map((x) => [x.status, x.n]));
  const cards: CardEvent[] = cd.map((c) => ({ fixture: Number(c.fixture_id), player: Number(c.player_id), type: String(c.type) }));
  const gws: GameweekRow[] = gw.map((g) => ({ n: g.round_number, status: g.status, lock: g.lockout_at ? new Date(g.lockout_at).toISOString() : null }));
  return { players, clubs, fixtures, events, deltas, cards, gws, snapshots: snaps[0].n, runs: runs[0].n, rounds: { total: gw.length, completed: done, attributed: p.processed ?? 0, skipped: p.skipped ?? 0, current: open ? open.round_number : gw.length ? gw[gw.length - 1].round_number : null } };
}
