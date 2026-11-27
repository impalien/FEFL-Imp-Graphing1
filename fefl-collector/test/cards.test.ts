import test from 'node:test';
import assert from 'node:assert/strict';
import { countCards, oneYellowFromBan } from '../src/analytics/cardMetrics.ts';
import { buildStatsExport, groupFixtures } from '../src/export.ts';
import type { ExportInput } from '../src/export.ts';

const ev = (fixture: number, player: number, type: string) => ({ fixture, player, type });

test('yellows are counted per player across matches; reds are separate', () => {
  const c = countCards([ev(1, 7, 'YellowCard'), ev(2, 7, 'YellowCard'), ev(3, 7, 'YellowCard'), ev(3, 8, 'RedCard'), ev(4, 9, 'Goal')]);
  assert.deepEqual(c.get(7), { yc: 3, rc: 0 });
  assert.deepEqual(c.get(8), { yc: 0, rc: 1 });
  assert.equal(c.has(9), false);
});

test('two yellows in one match are a red, and neither yellow counts towards a ban', () => {
  const c = countCards([ev(1, 7, 'YellowCard'), ev(2, 7, 'YellowCard'), ev(2, 7, 'YellowCard'), ev(2, 7, 'RedCard')]);
  assert.deepEqual(c.get(7), { yc: 1, rc: 1 });
  const s = countCards([ev(5, 3, 'YellowCard'), ev(5, 3, 'SecondYellow')]);
  assert.deepEqual(s.get(3), { yc: 0, rc: 1 });
});

test('one yellow from a ban: only while the ladder window is still open', () => {
  assert.deepEqual(oneYellowFromBan(4, 16), { next: 5, ban: 1, matchesLeft: 3 });
  assert.equal(oneYellowFromBan(4, 19), null);                 // the 19th match has been played: the 5-yellow window has closed
  assert.deepEqual(oneYellowFromBan(9, 25), { next: 10, ban: 2, matchesLeft: 12 });
  assert.equal(oneYellowFromBan(3, 10), null);
  assert.equal(oneYellowFromBan(5, 10), null);                 // already banned, the status field covers that
});

test('fixtures are grouped by gameweek and a double gameweek lists the club twice', () => {
  const fx = [
    { id: 2, finalized: false, home: 10, away: 20, hs: null, as: null, kickoff: '2026-12-02T19:45:00.000Z', status: 'scheduled', round: 17 },
    { id: 1, finalized: false, home: 30, away: 10, hs: null, as: null, kickoff: '2026-11-28T15:00:00.000Z', status: 'scheduled', round: 17 },
    { id: 3, finalized: false, home: 20, away: 40, hs: null, as: null, kickoff: '2026-12-05T15:00:00.000Z', status: 'scheduled', round: 18 },
  ];
  const g = groupFixtures(fx, [{ n: 17, status: 'upcoming', lock: null }, { n: 18, status: 'upcoming', lock: null }, { n: 19, status: 'upcoming', lock: null }]);
  assert.equal(g[0].g.length, 2);
  assert.equal(g[0].g.filter((x) => x[1] === 10 || x[2] === 10).length, 2);   // club 10 plays twice in round 17
  assert.equal(g[0].g[0][0], 1);                                               // earliest kickoff first
  assert.equal(g[2].g.length, 0);
});

test('export carries yellow counts, the one-yellow warning and the fixture list', () => {
  const zero = { appearances: 10, goalsScored: 0, assists: 0, keyPasses: 0, shotsOnTarget: 0, cleanSheets: 0, clearances: 0, blocks: 0, tackles: 0, interceptions: 0, saves: 0 };
  const fixtures = Array.from({ length: 16 }, (_, k) => ({ id: 100 + k, finalized: true, home: 10, away: 20 + k, hs: 1, as: 0, kickoff: null, status: 'completed', round: k + 1 }));
  const input = {
    players: [{ id: 1, club: 10, comp: 1, name: 'T. Player', pos: 'DEF' as const, status: 'active', pts: 40, avg: 4, rp: 3, l3: [], own: 5, s: zero, inj: null, sus: null }],
    clubs: [{ id: 10, comp: 1, name: 'Club', short: 'Club', abbr: 'CLB', pos: 1, form: [], fdrH: 3, fdrA: 3, bg: '#000', tx: '#fff', pts: 10, l3: [], own: 1 }],
    fixtures, events: [], deltas: [], snapshots: 1, runs: 1, now: new Date('2026-11-27T10:00:00Z'),
    rounds: { total: 46, completed: 16, attributed: 0, skipped: 0, current: 17 },
    cards: [ev(100, 1, 'YellowCard'), ev(101, 1, 'YellowCard'), ev(102, 1, 'YellowCard'), ev(103, 1, 'YellowCard')],
    gws: [{ n: 1, status: 'completed', lock: null }],
  } as ExportInput;
  const out = buildStatsExport(input) as { players: { yc: number; cw?: { n: number; b: number; l: number } }[]; fx: { n: number; g: unknown[] }[]; meta: { schema: number } };
  assert.equal(out.players[0].yc, 4);
  assert.deepEqual(out.players[0].cw, { n: 5, b: 1, l: 3 });                  // club has played 16, window runs to its 19th
  assert.equal(out.fx[0].g.length, 1);
  assert.equal(out.meta.schema, 2);
});
