import { getJson } from './http.ts';
import type { RawRound } from '../types.ts';

export const URL_ROUNDS = 'https://fantasy.efl.com/json/fantasy/rounds.json';

/** Collector step: request rounds.json and sanity check it so a bad response never pollutes the database. */
export async function collectRounds(): Promise<{ data: RawRound[]; text: string }> {
  const { data, text } = await getJson<RawRound[]>(URL_ROUNDS);
  if (!Array.isArray(data) || data.length < 1) throw new Error('rounds.json looks wrong: ' + (Array.isArray(data) ? data.length + ' rows' : typeof data));
  return { data, text };
}
