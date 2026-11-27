/**
 * Yellow cards and EFL suspension ladder, built from match events (the Fantasy EFL player file publishes no card counts).
 *
 * EFL league rules (Championship, League One, League Two; checked 2026-11 against the EFL/FA published thresholds):
 *   5 yellows by a club's 19th league match  -> 1 match ban
 *   10 yellows by its 37th league match      -> 2 match ban
 *   15 yellows by its 38th league match      -> 3 match ban (sources differ slightly on this last cut-off; it is far off, so it only matters in spring)
 * Cup and Trophy cards do not count towards the league total. Two yellows in one match mean a red card, and those two yellows do not count.
 * All of it lives in BAN_LADDER so a rule change is a one-line edit.
 */
export interface CardEvent { fixture: number; player: number; type: string }
export interface PlayerCards { yc: number; rc: number }

export const BAN_LADDER = [
  { yellows: 5, lastMatch: 19, ban: 1 },
  { yellows: 10, lastMatch: 37, ban: 2 },
  { yellows: 15, lastMatch: 38, ban: 3 },
] as const;

const norm = (t: string) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isYellow = (t: string) => norm(t) === 'yellowcard' || norm(t) === 'yellow';
const isRed = (t: string) => norm(t) === 'redcard' || norm(t) === 'red';
const isSecondYellow = (t: string) => /secondyellow|yellowred|2ndyellow/.test(norm(t));

/** Per player: yellows that count towards a ban, and red cards. Dismissals for two yellows are counted as a red, not as two yellows. */
export function countCards(events: CardEvent[]): Map<number, PlayerCards> {
  const perMatch = new Map<string, { player: number; y: number; r: number; s: number }>();
  for (const e of events) {
    const y = isYellow(e.type), r = isRed(e.type), s = isSecondYellow(e.type);
    if (!y && !r && !s) continue;
    const k = `${e.fixture}|${e.player}`;
    const m = perMatch.get(k) ?? { player: e.player, y: 0, r: 0, s: 0 };
    if (y) m.y++; if (r) m.r++; if (s) m.s++;
    perMatch.set(k, m);
  }
  const out = new Map<number, PlayerCards>();
  for (const m of perMatch.values()) {
    const c = out.get(m.player) ?? { yc: 0, rc: 0 };
    const sentOffForTwo = m.s > 0 || m.y >= 2;
    c.yc += sentOffForTwo ? 0 : m.y;
    c.rc += m.r > 0 || sentOffForTwo ? 1 : 0;
    out.set(m.player, c);
  }
  return out;
}

/** One booking away from a ban? Returns the next threshold, the ban it brings and how many league matches the window still covers. */
export function oneYellowFromBan(yellows: number, clubGames: number): { next: number; ban: number; matchesLeft: number } | null {
  for (const t of BAN_LADDER) {
    if (yellows === t.yellows - 1 && clubGames < t.lastMatch) return { next: t.yellows, ban: t.ban, matchesLeft: t.lastMatch - clubGames };
  }
  return null;
}
