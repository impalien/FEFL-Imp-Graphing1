import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeRound, buildConcede, leagueTotals, multiplier, clubSeason, emptyLine } from '../src/analytics/teamMetrics.ts';
import type { PlayerAt } from '../src/analytics/teamMetrics.ts';
import { collectionDue } from '../src/schedule.ts';
import { buildStatsExport } from '../src/export.ts';
import { derive } from '../src/analytics/playerMetrics.ts';
import type { RawRound, StatLine } from '../src/types.ts';

const line = (o: Partial<StatLine>): StatLine => ({ ...emptyLine(), ...o });
const P = (id: number, club: number, pos: 'MID' | 'DEF', s: Partial<StatLine>): PlayerAt => ({ id, club, pos, s: line(s) });
const round = (games: { id: number; home: number; away: number }[]): RawRound => ({ id: 1, roundNumber: 1, name: 'GW1', status: 'completed', lockoutDate: '2026-08-14T19:00:00Z', completedAt: '2026-08-18T10:00:00Z', avgPoints: 40,
  games: games.map((g) => ({ id: g.id, competitionId: 10, date: '2026-08-15T14:00:00Z', status: 'completed', isFinalized: true, homeId: g.home, awayId: g.away, homeScore: 1, awayScore: 0, events: [] })) });

test('after minus before is attributed to the opponent, grouped by position', () => {
  const before = new Map([[1, P(1, 10, 'MID', { appearances: 5, interceptions: 8 })], [2, P(2, 10, 'DEF', { appearances: 5, tackles: 10 })], [3, P(3, 20, 'MID', { appearances: 5, interceptions: 3 })]]);
  const after = new Map([[1, P(1, 10, 'MID', { appearances: 6, interceptions: 12 })], [2, P(2, 10, 'DEF', { appearances: 6, tackles: 12 })], [3, P(3, 20, 'MID', { appearances: 6, interceptions: 3 })]]);
  const d = attributeRound(round([{ id: 100, home: 10, away: 20 }]), before, after);
  assert.equal(d.length, 3);
  const c = buildConcede(d);
  assert.equal(c.get(20)!.pos.MID.interceptions, 4);   // club 20 conceded 4 interceptions to club 10's midfielders
  assert.equal(c.get(20)!.pos.DEF.tackles, 2);
  assert.equal(c.get(10)!.pos.MID.interceptions, 0);
  assert.equal(c.get(20)!.n, 1);
});

test('double gameweeks, non-appearances and downward corrections are skipped', () => {
  const before = new Map([[1, P(1, 10, 'MID', { appearances: 5 })], [2, P(2, 20, 'MID', { appearances: 5, interceptions: 5 })], [3, P(3, 30, 'MID', { appearances: 5 })]]);
  const after = new Map([[1, P(1, 10, 'MID', { appearances: 7 })], [2, P(2, 20, 'MID', { appearances: 6, interceptions: 4 })], [3, P(3, 30, 'MID', { appearances: 5 })]]);
  assert.equal(attributeRound(round([{ id: 1, home: 10, away: 20 }, { id: 2, home: 30, away: 10 }]), before, after).length, 0);
});

test('multiplier: shrinks small samples, clamps, and is 1 without data', () => {
  const mk = (n: number, ints: number) => ({ n, pos: { GK: line({}), DEF: line({}), MID: line({ interceptions: ints }), FWD: line({}) } });
  const lg = mk(100, 200);                              // league: 2.0 per game
  assert.equal(multiplier(undefined, lg, 'MID', 'interceptions'), 1);
  const one = multiplier(mk(1, 0), lg, 'MID', 'interceptions');      // 1 game, 0 conceded: heavily shrunk, not zero
  assert.ok(one > 0.8 && one < 1, String(one));
  const many = multiplier(mk(20, 20), lg, 'MID', 'interceptions');   // 1.0 per game over 20 games vs 2.0 league
  assert.ok(many < 0.7 && many >= 0.6, String(many));
  assert.equal(multiplier(mk(20, 400), lg, 'MID', 'interceptions'), 1.6);
});

test('collection schedule: 6h when quiet, 25 min on matchdays, forced and first runs', () => {
  const r = round([{ id: 1, home: 1, away: 2 }]); r.status = 'open'; r.completedAt = null;
  const kick = new Date('2026-08-15T14:00:00Z');
  const last = (m: number) => new Date(kick.getTime() + 60e3 * m);
  assert.equal(collectionDue([r], null, kick).due, true);
  assert.equal(collectionDue([r], last(70), last(100)).due, true);            // matchday, 30 min gap
  assert.equal(collectionDue([r], last(95), last(100)).due, false);
  const quiet = new Date('2026-08-20T10:00:00Z');
  assert.equal(collectionDue([r], new Date(quiet.getTime() - 3 * 3600e3), quiet).due, false);
  assert.equal(collectionDue([r], new Date(quiet.getTime() - 6 * 3600e3), quiet).due, true);
  assert.equal(collectionDue([r], new Date(quiet.getTime() - 60e3), quiet, true).due, true);
});

test('club season table and the website export', () => {
  const season = clubSeason([{ id: 1, finalized: true, home: 10, away: 20, hs: 2, as: 0 }], [{ fixture: 1, side: 'Away', type: 'YellowCard', n: 3 }]);
  assert.deepEqual(season.get(10), { games: 1, gf: 2, ga: 0, cs: 1, yc: 0, rc: 0 });
  assert.equal(season.get(20)!.yc, 3);
  const s = line({ appearances: 10, interceptions: 20, keyPasses: 15 });
  assert.equal(derive(s, 60).inta, 2);
  const out = buildStatsExport({
    players: [{ id: 1, club: 10, comp: 10, name: 'A. Test', pos: 'MID', status: 'playing', pts: 60, avg: 6, rp: 5, l3: [{ roundId: 1, points: 4 }, { roundId: 2, points: 5 }, { roundId: 3, points: 9 }], own: 12.5, s, inj: null, sus: null },
      { id: 2, club: 10, comp: 10, name: 'B. Gone', pos: 'DEF', status: 'eliminated', pts: 0, avg: 0, rp: 0, l3: [], own: 0, s: line({}), inj: null, sus: null },
      { id: 3, club: 20, comp: 10, name: 'C. Hurt', pos: 'FWD', status: 'injured', pts: 10, avg: 3, rp: 0, l3: [], own: 1, s: line({ appearances: 3 }), inj: { type: 'Knee', expectedEndDate: '2026-12-01', status: '2 | Out (0%)' }, sus: null }],
    clubs: [{ id: 10, comp: 10, name: 'Wolverhampton Wanderers', short: 'Wolves', abbr: 'WOL', pos: 3, form: ['W', 'W', 'D'], fdrH: 2, fdrA: 3, bg: '#fdb913', tx: '#000', pts: 120, l3: [{ roundId: 1, points: 30 }], own: 5 }],
    fixtures: [{ id: 1, finalized: true, home: 10, away: 20, hs: 2, as: 0 }], events: [], deltas: [], rounds: { total: 46, completed: 14, attributed: 0, skipped: 14, current: 15 }, snapshots: 3, runs: 1, now: new Date('2026-11-21T10:00:00Z') });
  assert.equal(out.players.length, 2);                   // the released player is dropped
  assert.equal(out.players[0].tr, 'rising');
  assert.equal(out.players[1].i?.c, 0);                   // "Out (0%)" -> chance 0
  assert.equal(out.clubs[0].fp, 7);
  assert.equal(out.meta.gameweek, 15);
});
