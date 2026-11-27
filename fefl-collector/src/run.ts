import fs from 'node:fs';
import path from 'node:path';
import { pool, close } from './database/db.ts';
import { SCHEMA } from './database/schema.ts';
import { collectPlayers, URL_PLAYERS } from './collector/players.ts';
import { collectSquads, URL_SQUADS } from './collector/squads.ts';
import { collectRounds, URL_ROUNDS } from './collector/rounds.ts';
import { collectionDue } from './schedule.ts';
import { attributeRound } from './analytics/teamMetrics.ts';
import { buildStatsExport } from './export.ts';
import * as db from './store.ts';

const force = process.argv.includes('--force');
const OUT = process.env.OUT_FILE ?? 'data/fefl-stats.json';
const now = new Date();

await pool.query(SCHEMA); // safe to repeat: only creates what is missing
const rounds = await collectRounds(); // fetched first: it tells us whether a full collection is due
const gate = collectionDue(rounds.data, await db.lastRunAt(), now, force);
console.log(`[collector] ${gate.due ? 'RUNNING' : 'skipping'}: ${gate.why}`);
if (!gate.due) { await close(); process.exit(0); }

const runId = await db.startRun(force ? 'manual' : process.env.GITHUB_EVENT_NAME ?? 'local');
try {
  const [players, squads] = await Promise.all([collectPlayers(), collectSquads()]);
  await db.storeRaw(runId, URL_PLAYERS, players.text);
  await db.storeRaw(runId, URL_SQUADS, squads.text);
  await db.storeRaw(runId, URL_ROUNDS, rounds.text);

  await db.upsertClubs(squads.data);
  await db.upsertPlayers(players.data);
  await db.upsertRounds(rounds.data);
  const added = {
    players: await db.appendPlayerSnapshots(runId, players.data),
    clubs: await db.appendClubSnapshots(runId, squads.data),
    fixtures: await db.appendFixtureSnapshots(runId, rounds.data),
  };
  await db.insertEvents(rounds.data, now);

  // Turn completed gameweeks into per-match player lines (needs a snapshot from BEFORE kick-off and one from AFTER completion).
  const done = await db.processedRounds();
  let attributed = 0;
  for (const r of rounds.data.filter((x) => x.status === 'completed' && x.completedAt && !done.has(x.id))) {
    const before = await db.playersAt(new Date(r.lockoutDate));
    const after = await db.playersAt(new Date(r.completedAt!));
    if (!before.size || !after.size) { await db.markRound(r.id, 'skipped', 'no snapshot from before this gameweek'); continue; }
    const deltas = attributeRound(r, before, after);
    await db.saveDeltas(deltas);
    await db.markRound(r.id, 'processed', `${deltas.length} player lines`);
    attributed++;
  }

  const input = await db.loadExportInput(now);
  const json = JSON.stringify(buildStatsExport({ ...input, now }));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  await db.finishRun(runId, 'ok', `snapshots added ${JSON.stringify(added)}; rounds attributed ${attributed}; wrote ${OUT} (${Math.round(json.length / 1024)} KB)`);
  console.log(`[collector] done. added ${JSON.stringify(added)}, rounds attributed ${attributed}, wrote ${OUT} (${Math.round(json.length / 1024)} KB)`);
} catch (e) {
  await db.finishRun(runId, 'failed', (e as Error).message);
  console.error('[collector] FAILED:', e);
  process.exitCode = 1;
} finally {
  await close();
}
