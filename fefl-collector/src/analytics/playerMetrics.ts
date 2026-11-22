import type { StatLine } from '../types.ts';

export const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Per-appearance rates for one player. Fantasy EFL publishes no minutes, so "per appearance" is the honest unit here;
 * the website joins in Highlightly minutes when it needs "per 90" style numbers.
 */
export function derive(s: StatLine, points: number) {
  const a = Math.max(1, s.appearances);
  return {
    gpa: r2(s.goalsScored / a), apa: r2(s.assists / a), gia: r2((s.goalsScored + s.assists) / a),
    kpa: r2(s.keyPasses / a), sota: r2(s.shotsOnTarget / a), inta: r2(s.interceptions / a),
    tka: r2(s.tackles / a), cla: r2(s.clearances / a), bla: r2(s.blocks / a), sva: r2(s.saves / a),
    csr: r2(s.cleanSheets / a), da: r2((s.tackles + s.clearances + s.blocks) / a), ppa: r2(points / a),
  };
}
export type Derived = ReturnType<typeof derive>;

/** Short keys used in the exported JSON (keeps the file small). */
export const SHORT = { appearances: 'ap', goalsScored: 'g', assists: 'a', keyPasses: 'kp', shotsOnTarget: 'sot', cleanSheets: 'cs', clearances: 'cl', blocks: 'bl', tackles: 'tk', interceptions: 'int', saves: 'sv' } as const;
export const shortLine = (s: StatLine) => Object.fromEntries(Object.entries(SHORT).map(([k, v]) => [v, s[k as keyof typeof SHORT]])) as Record<string, number>;
