// "npm run inspect": prints what the three Fantasy EFL files look like today, so you can spot it if the shape ever changes.
import { getJson } from './collector/http.ts';
for (const f of ['players', 'squads', 'rounds']) {
  const { data } = await getJson<Record<string, unknown>[]>(`https://fantasy.efl.com/json/fantasy/${f}.json`);
  console.log(`\n== ${f}.json: ${data.length} rows`);
  console.log('fields:', Object.keys(data[0]).join(', '));
  if (f === 'players') console.log('statuses:', JSON.stringify(data.reduce((a: Record<string, number>, p) => ((a[String(p.status)] = (a[String(p.status)] ?? 0) + 1), a), {})));
  if (f === 'rounds') {
    const t: Record<string, number> = {}, st: Record<string, number> = {};
    for (const r of data as any[]) for (const g of r.games ?? []) { st[String(g.status)] = (st[String(g.status)] ?? 0) + 1; for (const e of g.events ?? []) t[String(e.type)] = (t[String(e.type)] ?? 0) + 1; }
    console.log('event types:', JSON.stringify(t));
    console.log('game statuses:', JSON.stringify(st));
  }
  if (f === 'rounds') console.log('round statuses:', JSON.stringify(data.reduce((a: Record<string, number>, r) => ((a[String(r.status)] = (a[String(r.status)] ?? 0) + 1), a), {})));
}
