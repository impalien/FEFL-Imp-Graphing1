import { POSITIONS } from './types.ts';
import type { Pos, StatLine } from './types.ts';
import { derive, shortLine } from './analytics/playerMetrics.ts';
import { buildConcede, clubSeason, leagueTotals } from './analytics/teamMetrics.ts';
import type { EventCount, FixtureRow, MatchDelta } from './analytics/teamMetrics.ts';
import { formPoints, lastThreePoints, trend } from './analytics/formMetrics.ts';
import { countCards, oneYellowFromBan } from './analytics/cardMetrics.ts';
import type { CardEvent } from './analytics/cardMetrics.ts';

export interface PlayerRow {
  id: number; club: number; comp: number; name: string; pos: Pos; status: string; pts: number; avg: number; rp: number | null;
  l3: { roundId: number; points: number }[]; own: number; s: StatLine;
  inj: null | { type?: string; expectedEndDate?: string | null; status?: string }; sus: null | { matches?: number; endDate?: string | null; description?: string };
}
export interface ClubRow {
  id: number; comp: number; name: string; short: string; abbr: string; pos: number | null; form: string[]; fdrH: number | null; fdrA: number | null;
  bg: string; tx: string; pts: number; l3: { roundId: number; points: number }[]; own: number;
}
export interface ExportInput {
  players: PlayerRow[]; clubs: ClubRow[]; fixtures: FixtureRow[]; events: EventCount[]; deltas: MatchDelta[];
  rounds: { total: number; completed: number; attributed: number; skipped: number; current: number | null }; snapshots: number; runs: number; now: Date;
  cards?: CardEvent[]; gws?: GameweekRow[];
}
export interface GameweekRow { n: number; status: string; lock: string | null }

/** Every gameweek with its fixtures as compact rows: [fixtureId, homeClub, awayClub, kickoff, status, homeScore, awayScore]. A club listed twice in one gameweek is a double gameweek. */
export function groupFixtures(fixtures: FixtureRow[], gws: GameweekRow[]) {
  const by = new Map<number, FixtureRow[]>();
  for (const f of fixtures) if (f.round != null) by.set(f.round, [...(by.get(f.round) ?? []), f]);
  return gws.map((g) => ({
    n: g.n, st: g.status, lock: g.lock,
    g: (by.get(g.n) ?? []).sort((a, b) => String(a.kickoff ?? '').localeCompare(String(b.kickoff ?? '')) || a.id - b.id).map((f) => [f.id, f.home, f.away, f.kickoff ?? null, f.status ?? '', f.hs, f.as]),
  }));
}

const chance = (s?: string) => { const m = /\((\d+)%\)/.exec(s ?? ''); return m ? Number(m[1]) : null; };

/** Everything the website needs, built from database records (never straight from the Fantasy EFL API). Keys are short on purpose. */
export function buildStatsExport(i: ExportInput) {
  const season = clubSeason(i.fixtures, i.events);
  const concede = buildConcede(i.deltas);
  const lg = leagueTotals(concede);
  const cards = countCards(i.cards ?? []);
  const forTotals = new Map<number, Record<string, number>>();
  const players = i.players
    .filter((p) => p.status !== 'eliminated' && (p.s.appearances > 0 || p.status === 'injured' || p.status === 'suspended'))
    .map((p) => {
      const f = forTotals.get(p.club) ?? {};
      for (const [k, v] of Object.entries(shortLine(p.s))) f[k] = (f[k] ?? 0) + v;
      forTotals.set(p.club, f);
      const pc = cards.get(p.id) ?? { yc: 0, rc: 0 }, cw = oneYellowFromBan(pc.yc, season.get(p.club)?.games ?? 0);
      return {
        id: p.id, c: p.club, n: p.name, p: p.pos, s: p.status, o: p.own, t: p.pts, v: p.avg, r: p.rp, l: p.l3.map((x) => x.points), tr: trend(p.l3),
        ...shortLine(p.s), d: derive(p.s, p.pts), yc: pc.yc,
        ...(cw ? { cw: { n: cw.next, b: cw.ban, l: cw.matchesLeft } } : {}),
        ...(p.inj ? { i: { t: p.inj.type ?? '', c: chance(p.inj.status), e: p.inj.expectedEndDate ?? null } } : {}),
        ...(p.sus ? { x: { m: p.sus.matches ?? 1, e: p.sus.endDate ?? null, w: p.sus.description ?? '' } } : {}),
      };
    });
  const clubs = i.clubs.map((c) => {
    const s = season.get(c.id) ?? { games: 0, gf: 0, ga: 0, cs: 0, yc: 0, rc: 0 };
    return { id: c.id, comp: c.comp, name: c.name, short: c.short, abbr: c.abbr, pos: c.pos, form: c.form, fp: formPoints(c.form), fdrH: c.fdrH, fdrA: c.fdrA, bg: c.bg, tx: c.tx, pts: c.pts, l3: lastThreePoints(c.l3), o: c.own, ...s, f: forTotals.get(c.id) ?? {} };
  });
  const cc: Record<number, unknown> = {};
  for (const [id, c] of concede) cc[id] = { n: c.n, ...Object.fromEntries(POSITIONS.map((p) => [p, shortLine(c.pos[p])])) };
  return {
    meta: { schema: 2, generatedAt: i.now.toISOString(), source: 'fantasy.efl.com', gameweek: i.rounds.current, rounds: i.rounds, snapshots: i.snapshots, runs: i.runs, players: players.length },
    clubs, players, fx: groupFixtures(i.fixtures, i.gws ?? []), concede: cc, lg: { n: lg.n, ...Object.fromEntries(POSITIONS.map((p) => [p, shortLine(lg.pos[p])])) },
  };
}
