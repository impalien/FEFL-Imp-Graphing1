import { getJson } from './http.ts';
import type { RawPlayer } from '../types.ts';

export const URL_PLAYERS = 'https://fantasy.efl.com/json/fantasy/players.json';

/** Collector step: request players.json and sanity check it so a bad response never pollutes the database. */
export async function collectPlayers(): Promise<{ data: RawPlayer[]; text: string }> {
  const { data, text } = await getJson<RawPlayer[]>(URL_PLAYERS);
  if (!Array.isArray(data) || data.length < 300) throw new Error('players.json looks wrong: ' + (Array.isArray(data) ? data.length + ' rows' : typeof data));
  return { data, text };
}
