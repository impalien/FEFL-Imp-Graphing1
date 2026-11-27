import type { RawRound } from './types.ts';

/**
 * "Every 6 hours normally, every 30 minutes on active matchdays, straight after a gameweek completes."
 * GitHub wakes the job every 30 minutes on matchdays; this decides whether a full collection is actually due.
 */
export function collectionDue(rounds: RawRound[], lastRun: Date | null, now: Date, force = false): { due: boolean; why: string } {
  if (force) return { due: true, why: 'forced' };
  if (!lastRun) return { due: true, why: 'first run' };
  const t = now.getTime(), H = 3600e3;
  const games = rounds.flatMap((r) => r.games);
  const live = games.some((g) => { const k = new Date(g.date).getTime(); return t >= k - 0.5 * H && t <= k + 3.5 * H; });
  const settling = games.some((g) => !g.isFinalized && new Date(g.date).getTime() < t - 3.5 * H && new Date(g.date).getTime() > t - 48 * H);
  const justDone = rounds.some((r) => r.status === 'completed' && r.completedAt && t - new Date(r.completedAt).getTime() < 2 * H);
  const gapMin = live || settling || justDone ? 25 : 330;
  const sinceMin = (t - lastRun.getTime()) / 60e3;
  return { due: sinceMin >= gapMin, why: `${live ? 'matchday' : settling ? 'results settling' : justDone ? 'gameweek just completed' : 'quiet period'}, ${Math.round(sinceMin)} min since last run (needs ${gapMin})` };
}
