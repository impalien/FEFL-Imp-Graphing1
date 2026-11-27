import { POSITIONS, STAT_KEYS } from '../types.ts';
import type { Pos, RawGame, RawRound, StatLine } from '../types.ts';

export interface PlayerAt { id: number; club: number; pos: Pos; s: StatLine }
export interface MatchDelta { fixtureId: number; playerId: number; club: number; opp: number; pos: Pos; d: StatLine }

export const emptyLine = (): StatLine => Object.fromEntries(STAT_KEYS.map((k) => [k, 0])) as StatLine;
const sub = (a: StatLine, b: StatLine): StatLine => Object.fromEntries(STAT_KEYS.map((k) => [k, b[k] - a[k]])) as StatLine;

/**
 * THE KEY IDEA. Fantasy EFL only publishes season totals per player. If we hold a snapshot from before a gameweek and one from after
 * it, then (after - before) is exactly what each player did that week. A club with ONE game that week can have that line attributed
 * to that game, and therefore to the opponent: "what did Barnsley concede to midfielders". Double gameweeks are skipped because the
 * two games cannot be separated from totals alone.
 */
export function attributeRound(round: RawRound, before: Map<number, PlayerAt>, after: Map<number, PlayerAt>): MatchDelta[] {
  const byClub = new Map<number, RawGame[]>();
  for (const g of round.games) for (const c of [g.homeId, g.awayId]) byClub.set(c, [...(byClub.get(c) ?? []), g]);
  const out: MatchDelta[] = [];
  for (const [id, aft] of after) {
    const bef = before.get(id);
    const games = byClub.get(aft.club);
    if (!bef || !games || games.length !== 1 || !games[0].isFinalized) continue;
    const d = sub(bef.s, aft.s);
    if (d.appearances < 1 || STAT_KEYS.some((k) => d[k] < 0)) continue; // did not play, or the source corrected a number downwards
    const g = games[0];
    out.push({ fixtureId: g.id, playerId: id, club: aft.club, opp: g.homeId === aft.club ? g.awayId : g.homeId, pos: aft.pos, d });
  }
  return out;
}

export interface Concede { n: number; pos: Record<Pos, StatLine> }

/** For every club: what the players who faced it did, grouped by their position. Sums plus the number of games behind them. */
export function buildConcede(deltas: MatchDelta[]): Map<number, Concede> {
  const m = new Map<number, Concede>();
  const games = new Map<number, Set<number>>();
  for (const x of deltas) {
    const c = m.get(x.opp) ?? { n: 0, pos: Object.fromEntries(POSITIONS.map((p) => [p, emptyLine()])) as Record<Pos, StatLine> };
    for (const k of STAT_KEYS) c.pos[x.pos][k] += x.d[k];
    m.set(x.opp, c);
    games.set(x.opp, (games.get(x.opp) ?? new Set()).add(x.fixtureId));
  }
  for (const [club, c] of m) c.n = games.get(club)!.size;
  return m;
}

/** League-wide totals and games, so rates can be compared with the league average. */
export function leagueTotals(c: Map<number, Concede>): Concede {
  const t: Concede = { n: 0, pos: Object.fromEntries(POSITIONS.map((p) => [p, emptyLine()])) as Record<Pos, StatLine> };
  for (const x of c.values()) { t.n += x.n; for (const p of POSITIONS) for (const k of STAT_KEYS) t.pos[p][k] += x.pos[p][k]; }
  return t;
}

/**
 * Turn a club's concession rate into a multiplier for a player's rate (1.00 = league average). Small samples are pulled
 * towards 1 (k games of "average" are added), and the result is clamped so one odd game cannot swing a prediction.
 * The website uses the same formula, so the two always agree.
 */
export function multiplier(club: Concede | undefined, league: Concede, pos: Pos, key: keyof StatLine, k = 6): number {
  if (!club || club.n < 1 || league.n < 1) return 1;
  const avg = league.pos[pos][key] / league.n;
  if (avg <= 0) return 1;
  const shrunk = (club.pos[pos][key] + k * avg) / (club.n + k);
  return Math.min(1.6, Math.max(0.6, shrunk / avg));
}

export interface ClubSeason { games: number; gf: number; ga: number; cs: number; yc: number; rc: number }
export interface FixtureRow { id: number; finalized: boolean; home: number; away: number; hs: number | null; as: number | null; kickoff?: string | null; status?: string; round?: number | null }
export interface EventCount { fixture: number; side: 'Home' | 'Away'; type: string; n: number }

/** Results table numbers per club from finalized fixtures, plus cards from match events. */
export function clubSeason(fixtures: FixtureRow[], events: EventCount[]): Map<number, ClubSeason> {
  const m = new Map<number, ClubSeason>();
  const get = (id: number) => m.get(id) ?? (m.set(id, { games: 0, gf: 0, ga: 0, cs: 0, yc: 0, rc: 0 }), m.get(id)!);
  const fx = new Map(fixtures.map((f) => [f.id, f]));
  for (const f of fixtures) {
    if (!f.finalized || f.hs == null || f.as == null) continue;
    const h = get(f.home), a = get(f.away);
    h.games++; a.games++; h.gf += f.hs; h.ga += f.as; a.gf += f.as; a.ga += f.hs;
    if (f.as === 0) h.cs++;
    if (f.hs === 0) a.cs++;
  }
  for (const e of events) {
    const f = fx.get(e.fixture);
    if (!f) continue;
    const c = get(e.side === 'Home' ? f.home : f.away);
    if (e.type === 'YellowCard') c.yc += e.n;
    if (e.type === 'RedCard') c.rc += e.n;
  }
  return m;
}
