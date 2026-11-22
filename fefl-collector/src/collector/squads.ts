import { getJson } from './http.ts';
import type { RawSquad } from '../types.ts';

export const URL_SQUADS = 'https://fantasy.efl.com/json/fantasy/squads.json';

/** Collector step: request squads.json and sanity check it so a bad response never pollutes the database. */
export async function collectSquads(): Promise<{ data: RawSquad[]; text: string }> {
  const { data, text } = await getJson<RawSquad[]>(URL_SQUADS);
  if (!Array.isArray(data) || data.length < 60) throw new Error('squads.json looks wrong: ' + (Array.isArray(data) ? data.length + ' rows' : typeof data));
  return { data, text };
}
