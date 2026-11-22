/** Recent form helpers (player and club). */
export const lastThreePoints = (l3: { points: number }[]) => l3.reduce((a, x) => a + x.points, 0);

/** 'rising' if the newest round beats the average of the two before it by 2+, 'falling' if it is 2+ below. */
export function trend(l3: { points: number }[]): 'rising' | 'falling' | 'flat' {
  if (l3.length < 3) return 'flat';
  const [a, b, c] = l3.map((x) => x.points);
  const d = c - (a + b) / 2;
  return d >= 2 ? 'rising' : d <= -2 ? 'falling' : 'flat';
}

/** Club form from the W/D/L letters: points won in the last three (W=3, D=1). */
export const formPoints = (f: string[]) => f.reduce((a, x) => a + (x === 'W' ? 3 : x === 'D' ? 1 : 0), 0);

/** Biggest movers in ownership between two snapshots (percent selected). */
export function ownershipMovers(prev: Map<number, number>, cur: Map<number, number>, top = 10) {
  const rows = [...cur].map(([id, v]) => ({ id, change: Math.round((v - (prev.get(id) ?? v)) * 10) / 10 })).filter((r) => r.change !== 0);
  rows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return rows.slice(0, top);
}
